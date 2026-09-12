/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// FULFILLMENT-CAS-OTP-ATOMICITY-A3 — PART 4
// STANDALONE REAL-POSTGRES CONCURRENCY + ROLLBACK PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, forces the REAL DrizzleOrderRepository /
// DrizzleGiftRepository / DrizzleFulfillmentTransactionPort and the REAL
// FulfillmentService, opens genuinely concurrent transactions on separate
// pooled connections, and exits non-zero on any failed assertion.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/fulfill_a3_p4_runa" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=fulfill_a3_p4 \
//     pnpm exec tsx apps/api/integration/realPgFulfillmentAtomicity.ts
//
// PROVES (and only claims) against real Postgres:
//   P1 concurrent CONFIRMED->PREPARING claim: exactly one CAS winner; loser
//      blocks on the row lock and persists nothing; OTP belongs to the winner
//   P2 PREPARING claim rollback restores CONFIRMED + NULL OTP
//   P3 concurrent OTP pickup: exactly one winner, OTP consumed once, gift
//      fulfilled once; loser blocks then gets no second mutation
//   P4 pickup gift-failure rollback restores order READY + OTP + gift CLAIMED,
//      then a retry succeeds exactly once
//   P5 advance vs cancel race: exactly one CAS winner, no resurrection
//   P6 replay of a consumed OTP is rejected with no duplicate side effect
//   P7 cancel + gift release rollback restores both, then retry cancels once
//
// DOES NOT claim: memory rollback (memory port is passthrough), F5 qr_token
// persistence, F6 checked_in persistence, order_status_history, outbox /
// durable event delivery. POST_COMMIT_EVENT_CRASH_WINDOW_REMAINS: YES.
// This is external CI evidence. No false CI coverage is claimed.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  FulfillmentGiftRepo,
  FulfillmentTransactionPort,
  FulfillmentTxRepos,
} from "../src/repositories/fulfillmentAtomicityContracts";

// ------------------------------------------------------------
// configuration
// ------------------------------------------------------------

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "fulfill_a3_p4";
const ISOLATION_MODE = process.env.HARNESS_ISOLATION_MODE ?? "DISPOSABLE_LOCAL_CLUSTER";

if (!DATABASE_URL) {
  console.error("BLOCKED: HARNESS_DATABASE_URL is not set (no safe Postgres available)");
  process.exit(2);
}

// ------------------------------------------------------------
// assertion bookkeeping
// ------------------------------------------------------------

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

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

// ------------------------------------------------------------
// test-only transaction-port wrappers (NO production code touched)
// ------------------------------------------------------------

class GatedConsumePort implements FulfillmentTransactionPort {
  constructor(
    private readonly inner: FulfillmentTransactionPort,
    private readonly onLocked: () => Promise<void>,
  ) {}

  runInTransaction<T>(fn: (repos: FulfillmentTxRepos) => Promise<T>): Promise<T> {
    const onLocked = this.onLocked;
    return this.inner.runInTransaction(async (repos) => {
      const orders = new Proxy(repos.orders, {
        get(target: any, prop: string | symbol): any {
          if (prop === "consumePickupOtp") {
            return async (orderId: string, fromStatus: string, otp: string) => {
              const row = await target.consumePickupOtp(orderId, fromStatus, otp);
              if (row) await onLocked();
              return row;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return fn({ orders: orders as FulfillmentTxRepos["orders"], gifts: repos.gifts });
    });
  }
}

class FailingGiftPort implements FulfillmentTransactionPort {
  constructor(private readonly inner: FulfillmentTransactionPort) {}

  runInTransaction<T>(fn: (repos: FulfillmentTxRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      const gifts = new Proxy(repos.gifts, {
        get(target: any, prop: string | symbol): any {
          if (prop === "markFulfilled") {
            return async (id: string, orderId: string) => {
              await target.markFulfilled(id, orderId);
              throw new Error("HARNESS_FORCED_GIFT_FAILURE");
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return fn({ orders: repos.orders, gifts: gifts as FulfillmentGiftRepo });
    });
  }
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const poolMain = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "fgaMain" });
  const poolA = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "fgaA" });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "fgaB" });
  const dbMain = drizzle(poolMain) as unknown as DrizzleDb;
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  // Dynamic imports after the DB is reachable.
  const { DrizzleOrderRepository } = await import(
    "../src/repositories/drizzle/drizzleOrderRepository"
  );
  const { DrizzleGiftRepository } = await import(
    "../src/repositories/drizzle/drizzleGiftRepository"
  );
  const { createFulfillmentTransactionPort } = await import(
    "../src/repositories/drizzle/fulfillmentTransactionPort"
  );
  const { FulfillmentService } = await import("../src/services/fulfillment");
  const { AppError } = await import("../src/middleware/envelope");

  const orderRepoMain = new DrizzleOrderRepository(dbMain);
  const giftRepoMain = new DrizzleGiftRepository(dbMain);

  const makeService = (
    handle: DrizzleDb,
    txOverride?: FulfillmentTransactionPort,
  ) =>
    new FulfillmentService(
      new DrizzleOrderRepository(handle),
      new DrizzleGiftRepository(handle),
      txOverride ?? createFulfillmentTransactionPort(handle),
    );

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
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check("P0_ISOLATION_GUARD", isolationOk, `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`);
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await poolMain.end();
    await poolA.end();
    await poolB.end();
    process.exit(1);
  }

  // ---------- tracking + helpers ----------
  const userIds: string[] = [];
  const restaurantIds: string[] = [];
  const menuItemIds: string[] = [];
  const orderIds: string[] = [];
  const giftIds: string[] = [];

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await poolMain.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };

  const orderState = async (id: string): Promise<{ status: string; pickup_otp: string | null }> => {
    const r = await poolMain.query<{ status: string; pickup_otp: string | null }>(
      "select status, pickup_otp from orders where id=$1",
      [id],
    );
    return r.rows[0]!;
  };

  const countIdleInTransaction = async (): Promise<number> =>
    count(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      [],
    );

  const waitUntilLocked = async (appName: string, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = await count(
        "select count(*)::int as n from pg_stat_activity where datname=current_database() and application_name=$1 and wait_event_type='Lock'",
        [appName],
      );
      if (n > 0) return true;
      await sleep(20);
    }
    return false;
  };

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await poolMain.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `harness-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await poolMain.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Harness ${TAG}`,
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

  async function seedGift(base: { userId: string; restaurantId: string; menuItemId: string }): Promise<string> {
    const gift = await giftRepoMain.create({
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
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await giftRepoMain.markPaid(gift.id);
    await giftRepoMain.markClaimed(gift.id, base.userId);
    giftIds.push(gift.id);
    return gift.id;
  }

  async function seedOrder(opts: {
    status: string;
    otp?: string | null;
    withGift?: boolean;
  }): Promise<{ orderId: string; giftId?: string; base: { userId: string; restaurantId: string; menuItemId: string } }> {
    const base = await seedBase();
    const giftId = opts.withGift ? await seedGift(base) : undefined;
    const orderId = randomUUID();
    await poolMain.query(
      "insert into orders (id, user_id, restaurant_id, total_amount, status, pickup_otp) values ($1,$2,$3,$4,$5,$6)",
      [orderId, base.userId, base.restaurantId, "100.00", opts.status, opts.otp ?? null],
    );
    if (giftId) {
      await poolMain.query(
        "insert into order_items (id, order_id, menu_item_id, name, base_price, item_subtotal, gift_id) values ($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), orderId, base.menuItemId, "Gift Meal", "0.00", "0.00", giftId],
      );
      await giftRepoMain.bindToOrder(giftId, orderId);
    }
    orderIds.push(orderId);
    return { orderId, giftId, base };
  }

  const outcome = async <T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; code?: string }> => {
    try {
      const value = await p;
      return { ok: true, value };
    } catch (err) {
      return { ok: false, code: err instanceof AppError ? err.code : String(err) };
    }
  };

  // ============================================================
  // P1 — CONCURRENT PREPARING CLAIM
  // ============================================================
  const p1 = await seedOrder({ status: "CONFIRMED" });
  const otpA = "1111";
  const otpB = "2222";
  const p1Gate = deferred();
  const p1Times: Record<string, number> = {};
  let p1LockObserved = false;

  const claim = (handle: DrizzleDb, label: string, otp: string, qr: string) =>
    createFulfillmentTransactionPort(handle).runInTransaction(async ({ orders }) => {
      p1Times[`s${label}`] = Date.now();
      await p1Gate.promise;
      const row = await orders.claimPreparingWithOtp(p1.orderId, "CONFIRMED", otp, qr);
      if (row) await sleep(450);
      p1Times[`e${label}`] = Date.now();
      return { label, otp, row };
    });

  const p1Race = Promise.all([
    claim(dbA, "A", otpA, `qr-${randomUUID()}`),
    claim(dbB, "B", otpB, `qr-${randomUUID()}`),
  ]);
  p1Gate.resolve();

  {
    const deadline = Date.now() + 420;
    while (Date.now() < deadline) {
      const waiting = await count(
        "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'",
        [],
      );
      if (waiting > 0) {
        p1LockObserved = true;
        break;
      }
      await sleep(20);
    }
  }

  const p1Results = await p1Race;
  const p1Winners = p1Results.filter((r) => r.row !== null);
  const p1Losers = p1Results.filter((r) => r.row === null);
  const p1State = await orderState(p1.orderId);
  const p1Winner = p1Winners[0];
  const p1Loser = p1Losers[0];
  const p1Durations = p1Results.map((r) => p1Times[`e${r.label}`]! - p1Times[`s${r.label}`]!);
  const p1LoserBlocked = Math.max(...p1Durations) >= 300;
  const p1Overwrite = await orderRepoMain.claimPreparingWithOtp(
    p1.orderId,
    "CONFIRMED",
    p1Loser?.otp ?? "9999",
    `qr-${randomUUID()}`,
  );

  check("P1_ONE_WINNER_ONE_LOSER", p1Winners.length === 1 && p1Losers.length === 1, `winners=${p1Winners.length} losers=${p1Losers.length}`);
  check("P1_FINAL_STATUS_PREPARING", p1State.status === "PREPARING", `final=${p1State.status}`);
  check(
    "P1_PERSISTED_OTP_BELONGS_TO_WINNER",
    p1Winner !== undefined && p1State.pickup_otp === p1Winner.otp,
    `winner=${p1Winner?.label} persisted=${p1State.pickup_otp}`,
  );
  check("P1_LOSER_CANNOT_OVERWRITE", p1Overwrite === null && p1State.pickup_otp === p1Winner?.otp, `overwrite=${p1Overwrite === null ? "null" : "ROW"}`);
  check(
    "P1_LOSER_BLOCKED_ON_ROW_LOCK",
    p1LockObserved && p1LoserBlocked && p1Winner !== undefined && p1Winner.row?.pickup_otp === p1Winner.otp,
    `lockObserved=${p1LockObserved} durations=[${p1Durations.join(",")}]`,
  );
  console.log(`P1_WINNER=${p1Winner?.label} P1_LOSER=${p1Loser?.label}`);
  console.log(`P1_PERSISTED_OTP=${p1State.pickup_otp}`);

  // ============================================================
  // P2 — PREPARING ROLLBACK
  // ============================================================
  const p2 = await seedOrder({ status: "CONFIRMED" });
  let p2Threw = false;
  try {
    await dbMain.transaction(async (tx) => {
      const orders = new DrizzleOrderRepository(tx as unknown as DrizzleDb);
      const row = await orders.claimPreparingWithOtp(p2.orderId, "CONFIRMED", "3333", `qr-${randomUUID()}`);
      if (!row) throw new Error("P2_UNEXPECTED_NO_CLAIM");
      throw new Error("HARNESS_FORCED_ROLLBACK_P2");
    });
  } catch (err) {
    p2Threw = err instanceof Error && err.message === "HARNESS_FORCED_ROLLBACK_P2";
  }
  const p2State = await orderState(p2.orderId);
  check(
    "P2_PREPARING_ROLLBACK",
    p2Threw && p2State.status === "CONFIRMED" && p2State.pickup_otp === null,
    `threw=${p2Threw} status=${p2State.status} otp=${p2State.pickup_otp}`,
  );
  console.log(`P2_STATUS=${p2State.status} P2_OTP=${p2State.pickup_otp}`);

  // ============================================================
  // P3 — CONCURRENT OTP PICKUP
  // ============================================================
  const p3 = await seedOrder({ status: "READY_FOR_PICKUP", otp: "4444", withGift: true });
  const p3GiftId = p3.giftId!;
  const p3Locked = deferred();
  const p3Release = deferred();
  const p3ServiceA = makeService(
    dbA,
    new GatedConsumePort(createFulfillmentTransactionPort(dbA), async () => {
      p3Locked.resolve();
      await p3Release.promise;
    }),
  );
  const p3ServiceB = makeService(dbB);

  const p3PromiseA = outcome(p3ServiceA.confirmPickup(p3.orderId, undefined, "4444"));
  await withTimeout(p3Locked.promise, 10000, "P3 winner never acquired the row lock");
  const p3PromiseB = outcome(p3ServiceB.confirmPickup(p3.orderId, undefined, "4444"));
  const p3LoserBlocked = await waitUntilLocked("fgaB", 8000);
  p3Release.resolve();
  const [p3ResA, p3ResB] = await Promise.all([p3PromiseA, p3PromiseB]);

  const p3Winners = [p3ResA, p3ResB].filter((r) => r.ok);
  const p3Losers = [p3ResA, p3ResB].filter((r) => !r.ok);
  const p3State = await orderState(p3.orderId);
  const p3Gift = await giftRepoMain.getById(p3GiftId);
  const p3ReplayConsume = await orderRepoMain.consumePickupOtp(p3.orderId, "READY_FOR_PICKUP", "4444");
  const p3ReplayGift = await giftRepoMain.markFulfilled(p3GiftId, p3.orderId);
  const p3GiftFulfilledRows = await count("select count(*)::int as n from gifts where id=$1 and status='FULFILLED'", [p3GiftId]);

  check("P3_ONE_WINNER_ONE_LOSER", p3Winners.length === 1 && p3Losers.length === 1, `winners=${p3Winners.length} losers=${p3Losers.length}`);
  check("P3_FINAL_STATUS_PICKED_UP", p3State.status === "PICKED_UP", `final=${p3State.status}`);
  check("P3_OTP_CONSUMED", p3State.pickup_otp === null, `otp=${p3State.pickup_otp}`);
  check("P3_GIFT_FULFILLED_ONCE", p3Gift?.status === "FULFILLED" && p3GiftFulfilledRows === 1, `gift=${p3Gift?.status}`);
  check("P3_LOSER_NO_SECOND_MUTATION", (p3Losers[0]?.code ?? "") !== "OK" && p3ReplayConsume === null && p3ReplayGift === null, `loserCode=${p3Losers[0]?.code} replayConsume=${p3ReplayConsume === null ? "null" : "ROW"}`);
  check("P3_LOSER_BLOCKED_ON_ROW_LOCK", p3LoserBlocked, `lockObserved=${p3LoserBlocked}`);
  console.log(`P3_WINNER_SIDE=${p3ResA.ok ? "A" : "B"} P3_LOSER_CODE=${p3Losers[0]?.code}`);
  console.log(`P3_GIFT_STATUS=${p3Gift?.status} P3_FULFILLED_AT=${p3Gift?.fulfilled_at ?? "null"}`);

  // ============================================================
  // P4 — PICKUP GIFT FAILURE ROLLBACK + RETRY
  // ============================================================
  const p4 = await seedOrder({ status: "READY_FOR_PICKUP", otp: "5555", withGift: true });
  const p4GiftId = p4.giftId!;
  const p4FailingService = makeService(
    dbMain,
    new FailingGiftPort(createFulfillmentTransactionPort(dbMain)),
  );
  let p4Threw = false;
  try {
    await p4FailingService.confirmPickup(p4.orderId, undefined, "5555");
  } catch (err) {
    p4Threw = err instanceof Error && err.message === "HARNESS_FORCED_GIFT_FAILURE";
  }
  const p4AfterFail = await orderState(p4.orderId);
  const p4GiftAfterFail = await giftRepoMain.getById(p4GiftId);
  const p4Retry = await makeService(dbMain).confirmPickup(p4.orderId, undefined, "5555");
  const p4AfterRetry = await orderState(p4.orderId);
  const p4GiftAfterRetry = await giftRepoMain.getById(p4GiftId);

  check(
    "P4_PICKUP_ROLLBACK",
    p4Threw &&
      p4AfterFail.status === "READY_FOR_PICKUP" &&
      p4AfterFail.pickup_otp === "5555" &&
      p4GiftAfterFail?.status === "CLAIMED" &&
      p4GiftAfterFail?.redeemed_order_id === p4.orderId,
    `threw=${p4Threw} status=${p4AfterFail.status} otp=${p4AfterFail.pickup_otp} gift=${p4GiftAfterFail?.status}`,
  );
  check(
    "P4_RETRY_SUCCEEDS_ONCE",
    p4Retry.status === "PICKED_UP" && p4AfterRetry.pickup_otp === null && p4GiftAfterRetry?.status === "FULFILLED",
    `retryStatus=${p4Retry.status} otp=${p4AfterRetry.pickup_otp} gift=${p4GiftAfterRetry?.status}`,
  );
  console.log(`P4_AFTER_FAIL_STATUS=${p4AfterFail.status} P4_AFTER_FAIL_GIFT=${p4GiftAfterFail?.status}`);
  console.log(`P4_AFTER_RETRY_STATUS=${p4AfterRetry.status} P4_AFTER_RETRY_GIFT=${p4GiftAfterRetry?.status}`);

  // ============================================================
  // P5 — ADVANCE VS CANCEL RACE
  // ============================================================
  const p5 = await seedOrder({ status: "CONFIRMED" });
  const p5Gate = deferred();
  const p5ServiceA = makeService(dbA);
  const p5ServiceB = makeService(dbB);
  const p5Race = Promise.all([
    (async () => {
      await p5Gate.promise;
      const r = await outcome(p5ServiceA.advanceOrderStatus(p5.orderId));
      return { kind: "advance" as const, ...r };
    })(),
    (async () => {
      await p5Gate.promise;
      const r = await outcome(p5ServiceB.cancelOrder(p5.orderId));
      return { kind: "cancel" as const, ...r };
    })(),
  ]);
  p5Gate.resolve();
  const p5Results = await p5Race;
  const p5Winners = p5Results.filter((r) => r.ok);
  const p5Losers = p5Results.filter((r) => !r.ok);
  const p5State = await orderState(p5.orderId);
  const p5WinnerKind = p5Winners[0]?.kind ?? "none";
  const p5OneWinner = p5Winners.length === 1 && p5Losers.length === 1;
  const p5FinalMatchesWinner =
    (p5WinnerKind === "advance" && p5State.status === "PREPARING") ||
    (p5WinnerKind === "cancel" && p5State.status === "CANCELLED");
  const p5OtpRule =
    p5WinnerKind === "cancel"
      ? p5State.pickup_otp === null
      : p5State.pickup_otp !== null && /^\d{4}$/.test(p5State.pickup_otp);

  check("P5_ONE_CAS_WINNER", p5OneWinner, `winners=${p5Winners.length} losers=${p5Losers.length} winner=${p5WinnerKind}`);
  check("P5_FINAL_MATCHES_WINNER_NO_RESURRECTION", p5FinalMatchesWinner, `winner=${p5WinnerKind} final=${p5State.status}`);
  check("P5_OTP_RULE", p5OtpRule, `winner=${p5WinnerKind} otp=${p5State.pickup_otp}`);
  console.log(`P5_WINNER=${p5WinnerKind} P5_FINAL=${p5State.status} P5_OTP=${p5State.pickup_otp}`);
  console.log(`P5_LOSER_CODES=${p5Losers.map((l) => `${l.kind}:${l.code}`).join(",")}`);

  // ============================================================
  // P6 — REPLAY AFTER PICKUP
  // ============================================================
  const p6FulfilledAt = p3Gift?.fulfilled_at ?? null;
  const p6ReplayService = await outcome(makeService(dbMain).confirmPickup(p3.orderId, undefined, "4444"));
  const p6State = await orderState(p3.orderId);
  const p6Gift = await giftRepoMain.getById(p3GiftId);
  check(
    "P6_REPLAY_BLOCKED",
    p6ReplayService.ok === false &&
      p6State.status === "PICKED_UP" &&
      p6State.pickup_otp === null &&
      p6Gift?.status === "FULFILLED" &&
      p6Gift?.fulfilled_at === p6FulfilledAt,
    `replayOk=${p6ReplayService.ok} code=${p6ReplayService.code} status=${p6State.status} otp=${p6State.pickup_otp}`,
  );
  console.log(`P6_REPLAY_CODE=${p6ReplayService.code}`);

  // ============================================================
  // P7 — CANCEL + GIFT RELEASE ROLLBACK + RETRY
  // ============================================================
  const p7 = await seedOrder({ status: "CONFIRMED", withGift: true });
  const p7GiftId = p7.giftId!;
  let p7Threw = false;
  try {
    await createFulfillmentTransactionPort(dbMain).runInTransaction(async ({ orders, gifts }) => {
      const cancelled = await orders.transitionStatus(p7.orderId, "CONFIRMED", "CANCELLED");
      if (!cancelled) throw new Error("P7_UNEXPECTED_NO_CLAIM");
      await gifts.releaseFromOrder(p7GiftId, p7.orderId);
      throw new Error("HARNESS_FORCED_ROLLBACK_P7");
    });
  } catch (err) {
    p7Threw = err instanceof Error && err.message === "HARNESS_FORCED_ROLLBACK_P7";
  }
  const p7AfterFail = await orderState(p7.orderId);
  const p7GiftAfterFail = await giftRepoMain.getById(p7GiftId);
  const p7Retry = await makeService(dbMain).cancelOrder(p7.orderId);
  const p7AfterRetry = await orderState(p7.orderId);
  const p7GiftAfterRetry = await giftRepoMain.getById(p7GiftId);

  check(
    "P7_CANCEL_GIFT_ROLLBACK",
    p7Threw &&
      p7AfterFail.status === "CONFIRMED" &&
      p7GiftAfterFail?.status === "CLAIMED" &&
      p7GiftAfterFail?.redeemed_order_id === p7.orderId,
    `threw=${p7Threw} status=${p7AfterFail.status} gift=${p7GiftAfterFail?.status} bound=${p7GiftAfterFail?.redeemed_order_id === p7.orderId}`,
  );
  check(
    "P7_RETRY_CANCELS_ONCE",
    p7Retry.status === "CANCELLED" &&
      p7AfterRetry.status === "CANCELLED" &&
      p7GiftAfterRetry?.status === "ACTIVE" &&
      p7GiftAfterRetry?.redeemed_order_id === null,
    `retryStatus=${p7Retry.status} gift=${p7GiftAfterRetry?.status} bound=${p7GiftAfterRetry?.redeemed_order_id}`,
  );
  console.log(`P7_AFTER_FAIL_STATUS=${p7AfterFail.status} P7_AFTER_FAIL_GIFT=${p7GiftAfterFail?.status}`);
  console.log(`P7_AFTER_RETRY_STATUS=${p7AfterRetry.status} P7_AFTER_RETRY_GIFT=${p7GiftAfterRetry?.status}`);

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const realConcurrent = p1Winners.length === 1 && p1LockObserved && p3LoserBlocked;
  check("REAL_CONCURRENT_TX", realConcurrent, `p1Lock=${p1LockObserved} p3Lock=${p3LoserBlocked}`);
  console.log(`REAL_CONCURRENT_TX=${realConcurrent ? "YES" : "NO"}`);

  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from order_items where order_id = any($1::uuid[]) or gift_id = any($2::uuid[])", [orderIds, giftIds]],
    ["delete from orders where id = any($1::uuid[])", [orderIds]],
    ["delete from gifts where id = any($1::uuid[])", [giftIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await poolMain.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from orders where id = any($1::uuid[])", [orderIds])) +
    (await count("select count(*)::int as n from gifts where id = any($1::uuid[])", [giftIds])) +
    (await count("select count(*)::int as n from users where id = any($1::uuid[])", [userIds]));
  console.log(`CLEANUP_LEFTOVER_TEST_ROWS=${leftovers}`);
  check("CLEANUP_NO_LEFTOVER_ROWS", leftovers === 0, `leftovers=${leftovers}`);

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log(`UNHANDLED_REJECTION_COUNT=${unhandled}`);

  const idleAfter = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION_FINAL=${idleAfter}`);

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
