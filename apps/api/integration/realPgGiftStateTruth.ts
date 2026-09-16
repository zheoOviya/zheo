/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// GIFT-STATE-TRUTH-A2 — REAL-POSTGRES ATOMICITY PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, forces the REAL DrizzleGiftRepository over multiple
// independent connections, and exits non-zero on any failed assertion.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/gift_state_truth_run" \
//   HARNESS_EXPECT_DB_PREFIX=gift_state_truth \
//     pnpm exec tsx apps/api/integration/realPgGiftStateTruth.ts
//
// PROVES (and only claims) against real Postgres:
//   R1 CANCEL VS CAPTURE: PENDING cancel vs payment capture — exactly one wins;
//      an ACTIVE winner is never overwritten to CANCELLED
//   R2 CLAIM VS CANCEL: after a claim commits, a stale sender-cancel refund
//      reservation loses; gift stays CLAIMED with a null refund marker
//   R3 SWEEP VS BIND: a gift bound after a stale sweep read cannot be expired;
//      the order binding is preserved
//   R4 TWO EXPIRERS: two concurrent expiry CAS calls on the same due gift —
//      exactly one winner
//   R5 TERMINAL PRESERVATION: FULFILLED/CANCELLED/REFUNDED cannot be moved by
//      any covered CAS
//   R6 REFUND CONFIRM GUARD: ACTIVE -> markRefunded loses; REFUNDING ->
//      markRefunded wins
//
// DOES NOT claim: payment-source uniqueness (GIFT-5 hold), Razorpay behaviour,
// event delivery, order/payment mutation, or a central state machine.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type { GiftDTO, GiftStatus, GiftRepository } from "../src/repositories/giftRepository";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "gift_state_truth";
const ISOLATION_MODE = process.env.HARNESS_ISOLATION_MODE ?? "DISPOSABLE_LOCAL_CLUSTER";

if (!DATABASE_URL) {
  console.error("BLOCKED: HARNESS_DATABASE_URL is not set (no safe Postgres available)");
  process.exit(2);
}

const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];

function check(id: string, ok: boolean, detail?: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` :: ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const poolMain = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "gstMain" });
  const poolA = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "gstA" });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "gstB" });
  const dbMain = drizzle(poolMain) as unknown as DrizzleDb;
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  const { DrizzleGiftRepository } = await import(
    "../src/repositories/drizzle/drizzleGiftRepository"
  );

  const repoMain = new DrizzleGiftRepository(dbMain);
  const repoA = new DrizzleGiftRepository(dbA);
  const repoB = new DrizzleGiftRepository(dbB);

  // ---------- environment + isolation ----------
  const versionRes = await poolMain.query<{ version: string; db: string; user: string }>(
    "select version() as version, current_database() as db, current_user as user",
  );
  const version = versionRes.rows[0]!.version;
  const dbName = versionRes.rows[0]!.db;
  const dbUser = versionRes.rows[0]!.user;
  const postgresConfirmed = /PostgreSQL/i.test(version);
  const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

  console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
  console.log(`ISOLATION_MODE=${ISOLATION_MODE}`);
  console.log(`RUN_TAG=${TAG}`);
  console.log(`DATABASE_NAME=${dbName}`);
  console.log(`DATABASE_USER=${dbUser}`);
  console.log(`POSTGRES_VERSION=${version.split(" ").slice(0, 2).join(" ")}`);
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check("P0_ISOLATION_GUARD", isolationOk, `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`);
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await poolMain.end();
    await poolA.end();
    await poolB.end();
    process.exit(1);
  }

  const pidA = (await poolA.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const pidB = (await poolB.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  console.log(`CONN_A_PID=${pidA} CONN_B_PID=${pidB}`);
  check("MULTI_CONNECTION", pidA !== pidB, `pidA=${pidA} pidB=${pidB}`);

  // ---------- tracking + helpers ----------
  const userIds: string[] = [];
  const restaurantIds: string[] = [];
  const menuItemIds: string[] = [];
  const giftIds: string[] = [];

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await poolMain.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `gst-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await poolMain.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `GST Harness ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await poolMain.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Item ${TAG}`, "100.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  async function createGift(
    base: { userId: string; restaurantId: string; menuItemId: string },
    expiresInDays: number,
  ): Promise<string> {
    const gift = await repoMain.create({
      sender_id: base.userId,
      restaurant_id: base.restaurantId,
      menu_item_id: base.menuItemId,
      item_snapshot: {
        name: "Gift Meal",
        price: 100,
        image_url: null,
        dietary_tags: {},
        spice_level: 0,
        customizations: [],
      },
      price_paid: 100,
      message: null,
      recipient_name: null,
      claim_token: `gt-${TAG}-${randomUUID()}`,
      claim_code: "123456",
      expires_at: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
    });
    giftIds.push(gift.id);
    return gift.id;
  }

  async function advanceTo(
    repo: GiftRepository,
    id: string,
    status: GiftStatus,
    userId: string,
    orderId: string,
    farFutureIso: string,
  ): Promise<void> {
    if (status === "PENDING") return;
    if (status === "CANCELLED") {
      const cancelled = await repo.cancelPending(id);
      if (!cancelled) throw new Error(`advanceTo(${status}): cancelPending lost`);
      return;
    }
    const paid = await repo.markPaid(id);
    if (!paid) throw new Error(`advanceTo(${status}): markPaid lost`);
    if (status === "ACTIVE") return;
    if (status === "EXPIRED") {
      const expired = await repo.expireIfDueAndUnbound(id, farFutureIso);
      if (!expired) throw new Error("advanceTo(EXPIRED): expire lost");
      return;
    }
    if (status === "REFUNDING") {
      const reserved = await repo.markRefundSubmitted(id, ["ACTIVE"]);
      if (!reserved) throw new Error("advanceTo(REFUNDING): reserve lost");
      return;
    }
    if (status === "REFUNDED") {
      await repo.markRefundSubmitted(id, ["ACTIVE"]);
      const refunded = await repo.markRefunded(id);
      if (!refunded) throw new Error("advanceTo(REFUNDED): confirm lost");
      return;
    }
    const claimed = await repo.markClaimed(id, userId);
    if (!claimed) throw new Error(`advanceTo(${status}): markClaimed lost`);
    if (status === "CLAIMED") return;
    const bound = await repo.bindToOrder(id, orderId);
    if (!bound) throw new Error(`advanceTo(${status}): bind lost`);
    if (status === "FULFILLED") {
      const fulfilled = await repo.markFulfilled(id, orderId);
      if (!fulfilled) throw new Error("advanceTo(FULFILLED): fulfill lost");
      return;
    }
    throw new Error(`advanceTo: unsupported status ${status}`);
  }

  const finalStatus = async (id: string): Promise<GiftDTO> => {
    const got = await repoMain.getById(id);
    if (!got) throw new Error(`gift ${id} disappeared`);
    return got;
  };

  const farFutureIso = (): string => new Date(Date.now() + 400 * 86_400_000).toISOString();
  const nowIso = (): string => new Date().toISOString();

  // ============================================================
  // R1 — CANCEL VS CAPTURE
  // ============================================================
  const R1_ITERATIONS = 5;
  let r1Ok = true;
  let r1Detail = "";
  for (let i = 0; i < R1_ITERATIONS && r1Ok; i++) {
    const base = await seedBase();
    const id = await createGift(base, 30);
    const start = deferred();
    const pCancel = start.promise.then(() => repoA.cancelPending(id));
    const pPaid = start.promise.then(() => repoB.markPaid(id));
    start.resolve();
    const [cancelled, paid] = await Promise.all([pCancel, pPaid]);
    const final = await finalStatus(id);
    const valid =
      (cancelled !== null && paid === null && final.status === "CANCELLED") ||
      (cancelled === null && paid !== null && final.status === "ACTIVE");
    if (!valid) {
      r1Ok = false;
      r1Detail = `iter=${i} cancelled=${cancelled !== null} paid=${paid !== null} final=${final.status}`;
    }
    // The critical invariant: a paid (ACTIVE) winner is never clobbered.
    if (paid !== null && final.status !== "ACTIVE") {
      r1Ok = false;
      r1Detail = `iter=${i} ACTIVE winner overwritten to ${final.status}`;
    }
  }
  check(
    "R1_CANCEL_VS_CAPTURE_SINGLE_WINNER",
    r1Ok,
    r1Ok ? `${R1_ITERATIONS} concurrent rounds, one winner each` : r1Detail,
  );

  // ============================================================
  // R2 — CLAIM VS CANCEL (claim commits first; stale cancel must lose)
  // ============================================================
  const r2Base = await seedBase();
  const r2Id = await createGift(r2Base, 30);
  await repoMain.markPaid(r2Id);
  const r2Claim = await repoA.markClaimed(r2Id, r2Base.userId);
  // Stale sender-cancel reservations race on both connections after the claim.
  const [r2StaleA, r2StaleB] = await Promise.all([
    repoA.markRefundSubmitted(r2Id, ["ACTIVE"]),
    repoB.markRefundSubmitted(r2Id, ["ACTIVE"]),
  ]);
  const r2Final = await finalStatus(r2Id);
  check(
    "R2_CLAIM_WINS_STALE_CANCEL_LOSES",
    r2Claim?.status === "CLAIMED" &&
      r2StaleA === null &&
      r2StaleB === null &&
      r2Final.status === "CLAIMED" &&
      r2Final.refund_requested_at === null,
    `claim=${r2Claim?.status} staleA=${r2StaleA !== null} staleB=${r2StaleB !== null} final=${r2Final.status} marker=${r2Final.refund_requested_at !== null}`,
  );

  // ============================================================
  // R3 — SWEEP VS BIND
  // ============================================================
  const r3Base = await seedBase();
  const r3Id = await createGift(r3Base, -1); // already due
  await repoMain.markPaid(r3Id);
  await repoMain.markClaimed(r3Id, r3Base.userId);
  const r3StaleRead = await repoMain.getById(r3Id); // sweep candidate read
  const r3OrderId = randomUUID();
  const r3Bound = await repoA.bindToOrder(r3Id, r3OrderId);
  const r3Expired = await repoB.expireIfDueAndUnbound(r3Id, nowIso());
  const r3Final = await finalStatus(r3Id);
  check(
    "R3_BOUND_AFTER_STALE_READ_SURVIVES",
    r3StaleRead?.redeemed_order_id === null &&
      r3Bound?.redeemed_order_id === r3OrderId &&
      r3Expired === null &&
      r3Final.status !== "EXPIRED" &&
      r3Final.redeemed_order_id === r3OrderId,
    `staleUnbound=${r3StaleRead?.redeemed_order_id === null} expired=${r3Expired !== null} final=${r3Final.status} bound=${r3Final.redeemed_order_id}`,
  );

  // ============================================================
  // R4 — TWO EXPIRERS
  // ============================================================
  const r4Base = await seedBase();
  const r4Id = await createGift(r4Base, -1);
  await repoMain.markPaid(r4Id);
  const r4Start = deferred();
  const r4Now = nowIso();
  const r4pA = r4Start.promise.then(() => repoA.expireIfDueAndUnbound(r4Id, r4Now));
  const r4pB = r4Start.promise.then(() => repoB.expireIfDueAndUnbound(r4Id, r4Now));
  r4Start.resolve();
  const [r4a, r4b] = await Promise.all([r4pA, r4pB]);
  const r4Final = await finalStatus(r4Id);
  const r4Winners = [r4a, r4b].filter((r) => r !== null).length;
  check(
    "R4_TWO_EXPIRERS_ONE_WINNER",
    r4Winners === 1 && r4Final.status === "EXPIRED",
    `winners=${r4Winners} final=${r4Final.status}`,
  );

  // ============================================================
  // R5 — TERMINAL PRESERVATION
  // ============================================================
  const r5Base = await seedBase();
  const r5Far = farFutureIso();

  const r5Fulfilled = await createGift(r5Base, -1);
  await advanceTo(repoMain, r5Fulfilled, "FULFILLED", r5Base.userId, randomUUID(), r5Far);
  const r5FAttempts = [
    await repoMain.cancelPending(r5Fulfilled),
    await repoMain.markPaid(r5Fulfilled),
    await repoMain.markRefundSubmitted(r5Fulfilled, ["ACTIVE"]),
    await repoMain.markRefunded(r5Fulfilled),
    await repoMain.expireIfDueAndUnbound(r5Fulfilled, r5Far),
  ];
  const r5FFinal = await finalStatus(r5Fulfilled);

  const r5Cancelled = await createGift(r5Base, -1);
  await advanceTo(repoMain, r5Cancelled, "CANCELLED", r5Base.userId, randomUUID(), r5Far);
  const r5CAttempts = [
    await repoMain.markPaid(r5Cancelled),
    await repoMain.markRefundSubmitted(r5Cancelled, ["ACTIVE"]),
    await repoMain.markRefunded(r5Cancelled),
    await repoMain.expireIfDueAndUnbound(r5Cancelled, r5Far),
  ];
  const r5CFinal = await finalStatus(r5Cancelled);

  const r5Refunded = await createGift(r5Base, -1);
  await advanceTo(repoMain, r5Refunded, "REFUNDED", r5Base.userId, randomUUID(), r5Far);
  const r5RAttempts = [
    await repoMain.cancelPending(r5Refunded),
    await repoMain.markPaid(r5Refunded),
    await repoMain.markRefundSubmitted(r5Refunded, ["REFUNDING"]),
    await repoMain.markRefunded(r5Refunded),
    await repoMain.expireIfDueAndUnbound(r5Refunded, r5Far),
  ];
  const r5RFinal = await finalStatus(r5Refunded);

  check(
    "R5_TERMINAL_PRESERVATION",
    r5FAttempts.every((r) => r === null) &&
      r5FFinal.status === "FULFILLED" &&
      r5CAttempts.every((r) => r === null) &&
      r5CFinal.status === "CANCELLED" &&
      r5RAttempts.every((r) => r === null) &&
      r5RFinal.status === "REFUNDED",
    `fulfilled=${r5FFinal.status} cancelled=${r5CFinal.status} refunded=${r5RFinal.status}`,
  );

  // ============================================================
  // R6 — REFUND CONFIRM GUARD
  // ============================================================
  const r6Base = await seedBase();
  const r6Id = await createGift(r6Base, 30);
  await repoMain.markPaid(r6Id);
  const r6FromActive = await repoA.markRefunded(r6Id);
  const r6AfterActive = await finalStatus(r6Id);
  await repoMain.markRefundSubmitted(r6Id, ["ACTIVE"]);
  const r6FromRefunding = await repoB.markRefunded(r6Id);
  const r6Final = await finalStatus(r6Id);
  check(
    "R6_REFUND_CONFIRM_GUARD",
    r6FromActive === null &&
      r6AfterActive.status === "ACTIVE" &&
      r6FromRefunding?.status === "REFUNDED" &&
      r6Final.status === "REFUNDED",
    `fromActive=${r6FromActive !== null} afterActive=${r6AfterActive.status} fromRefunding=${r6FromRefunding?.status} final=${r6Final.status}`,
  );

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const idleBefore = (
    await poolMain.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
    )
  ).rows[0]!.n;
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", Number(idleBefore) === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from gifts where id = any($1::uuid[])", [giftIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await poolMain.query(sqlText, params as any[]);
  }
  const leftovers =
    (
      await poolMain.query<{ n: number }>(
        "select count(*)::int as n from gifts where id = any($1::uuid[])",
        [giftIds],
      )
    ).rows[0]!.n +
    (
      await poolMain.query<{ n: number }>(
        "select count(*)::int as n from users where id = any($1::uuid[])",
        [userIds],
      )
    ).rows[0]!.n;
  console.log(`CLEANUP_LEFTOVER_TEST_ROWS=${leftovers}`);
  check("CLEANUP_NO_LEFTOVER_ROWS", Number(leftovers) === 0, `leftovers=${leftovers}`);

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log(`UNHANDLED_REJECTION_COUNT=${unhandled}`);

  await poolMain.end();
  await poolA.end();
  await poolB.end();
  console.log("OPEN_DB_CONNECTIONS=CLOSED");

  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
