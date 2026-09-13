/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// CATERING-STATE-TRUTH-A2 — REAL-POSTGRES CAS PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database and forces the REAL DrizzleOrderRepository /
// DrizzleCatalogRepository / CateringService so the from-state CAS
// (DRAFT -> CONFIRMED) is proven against a real conditional UPDATE.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/catering_a1_p1_run" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=catering_a1 \
//     pnpm exec tsx apps/api/integration/realPgCateringStateTruth.ts
//
// PROVES (and only claims):
//   P0 production repo smoke (migrations present, DRAFT create works)
//   P1 DRAFT -> CONFIRMED CAS commits exactly one authoritative row
//   P2 replay of DRAFT -> CONFIRMED returns null; state stays CONFIRMED
//   P3 two concurrent confirms: exactly one winner, one null loser
//   P4 terminal (CANCELLED / PICKED_UP) cannot be blind-overwritten
//   P5 catering aggregate integrity (status/is_catering/headcount/items)
//
// DOES NOT claim: create+confirm transaction atomicity, rollback of a leaked
// DRAFT, memory rollback, durable event delivery, admin override (F1),
// commission persistence (F3), or order_status_history. Create and confirm are
// SEPARATE commits in this stream.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type { CreateOrderInput } from "../src/repositories/orderRepository";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "catering_a1";
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

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const poolMain = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "cstMain" });
  const poolA = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "cstA" });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: "cstB" });
  const dbMain = drizzle(poolMain) as unknown as DrizzleDb;
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  const { DrizzleOrderRepository } = await import(
    "../src/repositories/drizzle/drizzleOrderRepository"
  );
  const { DrizzleCatalogRepository } = await import("../src/repositories/catalogRepository");
  const { CateringService } = await import("../src/services/catering");
  const { calculatePriceBreakdown } = await import("../src/services/pricing");
  const { AppError } = await import("../src/middleware/envelope");

  const orderRepoMain = new DrizzleOrderRepository(dbMain);
  const catalogMain = new DrizzleCatalogRepository(dbMain);
  const cateringService = new CateringService(orderRepoMain, catalogMain);

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
  const committedOrderIds: string[] = [];

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await poolMain.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };

  const countIdleInTransaction = async (): Promise<number> =>
    count(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      [],
    );

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await poolMain.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `cst-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await poolMain.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Catering ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await poolMain.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Catering Item ${TAG}`, "100.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  function createInput(
    base: { userId: string; restaurantId: string; menuItemId: string },
    opts: { quantity?: number; headcount?: number } = {},
  ): CreateOrderInput {
    const quantity = opts.quantity ?? 60;
    const lines = [
      {
        menu_item_id: base.menuItemId,
        name: `Catering Item ${TAG}`,
        base_price: 100,
        quantity,
        customizations: [],
      },
    ];
    const breakdown = calculatePriceBreakdown(lines);
    return {
      user_id: base.userId,
      restaurant_id: base.restaurantId,
      items: lines.map((line) => ({
        ...line,
        gift_id: null,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)
            ?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)
            ?.item_subtotal ?? 0,
      })),
      breakdown,
      scheduled_pickup_time: "2099-09-01T10:30:00+05:30",
      is_catering: true,
      headcount: opts.headcount ?? 150,
    };
  }

  const ordersForUser = (userId: string): Promise<number> =>
    count("select count(*)::int as n from orders where user_id=$1", [userId]);
  const itemsForOrder = (orderId: string): Promise<number> =>
    count("select count(*)::int as n from order_items where order_id=$1", [orderId]);

  const outcome = async <T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; code?: string }> => {
    try {
      const value = await p;
      return { ok: true, value };
    } catch (err) {
      return { ok: false, code: err instanceof AppError ? err.code : String(err) };
    }
  };

  // ============================================================
  // P0 — PRODUCTION REPOSITORY SMOKE (DRAFT create)
  // ============================================================
  const p0Base = await seedBase();
  const p0Order = await orderRepoMain.create(createInput(p0Base));
  committedOrderIds.push(p0Order.id);
  const p0Loaded = await orderRepoMain.getById(p0Order.id);
  check(
    "P0_SMOKE_DRAFT_CREATE",
    p0Order.status === "DRAFT" && p0Loaded?.status === "DRAFT" && (await itemsForOrder(p0Order.id)) === 1,
    `created=${p0Order.status} loaded=${p0Loaded?.status} items=${await itemsForOrder(p0Order.id)}`,
  );
  console.log(`P0_ORDER=${p0Order.id} P0_STATUS=${p0Loaded?.status}`);

  // ============================================================
  // P1 — DRAFT -> CONFIRMED CAS COMMITS
  // ============================================================
  const p1Base = await seedBase();
  const p1Draft = await orderRepoMain.create(createInput(p1Base));
  committedOrderIds.push(p1Draft.id);
  const p1Confirmed = await orderRepoMain.transitionStatus(p1Draft.id, "DRAFT", "CONFIRMED");
  const p1Persisted = await orderRepoMain.getById(p1Draft.id);
  check(
    "P1_CAS_DRAFT_TO_CONFIRMED",
    p1Confirmed !== null && p1Confirmed.status === "CONFIRMED" && p1Persisted?.status === "CONFIRMED",
    `returned=${p1Confirmed?.status} persisted=${p1Persisted?.status}`,
  );
  console.log(`P1_ORDER=${p1Draft.id} P1_STATUS=${p1Persisted?.status}`);

  // ============================================================
  // P2 — REPLAY RETURNS NULL, STATE STAYS CONFIRMED
  // ============================================================
  const p2Replay = await orderRepoMain.transitionStatus(p1Draft.id, "DRAFT", "CONFIRMED");
  const p2Persisted = await orderRepoMain.getById(p1Draft.id);
  check(
    "P2_REPLAY_NULL_NO_SECOND_TRANSITION",
    p2Replay === null && p2Persisted?.status === "CONFIRMED" && (await ordersForUser(p1Base.userId)) === 1,
    `replay=${p2Replay === null ? "null" : p2Replay.status} persisted=${p2Persisted?.status}`,
  );
  console.log(`P2_REPLAY_NULL=${p2Replay === null} P2_STATUS=${p2Persisted?.status}`);

  // ============================================================
  // P3 — CONCURRENT CONFIRMS: ONE WINNER, ONE LOSER
  // ============================================================
  const p3Base = await seedBase();
  const p3Draft = await orderRepoMain.create(createInput(p3Base));
  committedOrderIds.push(p3Draft.id);
  const repoA = new DrizzleOrderRepository(dbA);
  const repoB = new DrizzleOrderRepository(dbB);
  const [p3ResA, p3ResB] = await Promise.all([
    outcome(repoA.transitionStatus(p3Draft.id, "DRAFT", "CONFIRMED")),
    outcome(repoB.transitionStatus(p3Draft.id, "DRAFT", "CONFIRMED")),
  ]);
  const p3Winners = [p3ResA, p3ResB].filter((r) => r.ok && r.value !== null);
  const p3Losers = [p3ResA, p3ResB].filter((r) => r.ok && r.value === null);
  const p3Final = await orderRepoMain.getById(p3Draft.id);
  check(
    "P3_ONE_WINNER_ONE_LOSER",
    p3Winners.length === 1 && p3Losers.length === 1 && p3Final?.status === "CONFIRMED",
    `winners=${p3Winners.length} losers=${p3Losers.length} final=${p3Final?.status}`,
  );
  console.log(
    `P3_WINNER_SIDE=${p3ResA.ok && p3ResA.value ? "A" : "B"} P3_FINAL=${p3Final?.status}`,
  );

  // ============================================================
  // P4 — TERMINAL STATE CANNOT BE BLIND-OVERWRITTEN
  // ============================================================
  const p4Base = await seedBase();
  const p4Draft = await orderRepoMain.create(createInput(p4Base));
  committedOrderIds.push(p4Draft.id);
  // Harness-only setup: force a terminal state directly.
  await orderRepoMain.updateStatus(p4Draft.id, "CANCELLED");
  const p4CasFromCancelled = await orderRepoMain.transitionStatus(p4Draft.id, "DRAFT", "CONFIRMED");
  const p4Persisted = await orderRepoMain.getById(p4Draft.id);

  const p4bBase = await seedBase();
  const p4bDraft = await orderRepoMain.create(createInput(p4bBase));
  committedOrderIds.push(p4bDraft.id);
  await orderRepoMain.updateStatus(p4bDraft.id, "PICKED_UP");
  const p4CasFromPicked = await orderRepoMain.transitionStatus(p4bDraft.id, "DRAFT", "CONFIRMED");
  const p4bPersisted = await orderRepoMain.getById(p4bDraft.id);

  check(
    "P4_TERMINAL_GUARD",
    p4CasFromCancelled === null &&
      p4Persisted?.status === "CANCELLED" &&
      p4CasFromPicked === null &&
      p4bPersisted?.status === "PICKED_UP",
    `cancelCas=${p4CasFromCancelled === null ? "null" : "ROW"} cancelState=${p4Persisted?.status} pickedCas=${p4CasFromPicked === null ? "null" : "ROW"} pickedState=${p4bPersisted?.status}`,
  );
  console.log(
    `P4_CANCELLED_STATE=${p4Persisted?.status} P4_PICKED_UP_STATE=${p4bPersisted?.status}`,
  );

  // ============================================================
  // P5 — CATERING AGGREGATE INTEGRITY VIA PRODUCTION SERVICE
  // ============================================================
  const p5Base = await seedBase();
  const p5Order = await cateringService.placeCateringOrder({
    user_id: p5Base.userId,
    restaurant_id: p5Base.restaurantId,
    event_date: "2099-09-01T10:30:00+05:30",
    headcount: 150,
    items: [{ menu_item_id: p5Base.menuItemId, quantity: 75 }],
  });
  committedOrderIds.push(p5Order.id);
  const p5Persisted = await orderRepoMain.getById(p5Order.id);
  const p5ItemRows = await itemsForOrder(p5Order.id);
  check(
    "P5_CATERING_FIELDS_INTEGRITY",
    p5Order.status === "CONFIRMED" &&
      p5Persisted?.status === "CONFIRMED" &&
      p5Persisted?.is_catering === true &&
      p5Persisted?.headcount === 150 &&
      p5ItemRows === 1 &&
      p5Persisted?.items[0]?.quantity === 75,
    `service=${p5Order.status} persisted=${p5Persisted?.status} catering=${p5Persisted?.is_catering} headcount=${p5Persisted?.headcount} itemRows=${p5ItemRows} qty=${p5Persisted?.items[0]?.quantity}`,
  );
  console.log(
    `P5_ORDER=${p5Order.id} P5_STATUS=${p5Persisted?.status} P5_HEADCOUNT=${p5Persisted?.headcount} P5_ITEMS=${p5ItemRows}`,
  );

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const realConcurrent = p3Winners.length === 1 && p3Losers.length === 1;
  check("REAL_CONCURRENT_TX", realConcurrent, `winners=${p3Winners.length}`);
  console.log(`REAL_CONCURRENT_TX=${realConcurrent ? "YES" : "NO"}`);

  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from order_items where order_id = any($1::uuid[])", [committedOrderIds]],
    ["delete from orders where id = any($1::uuid[])", [committedOrderIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await poolMain.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from orders where user_id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from order_items where order_id = any($1::uuid[])", [committedOrderIds])) +
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

// Keeps `sleep` referenced for parity with sibling harnesses (diagnostics).
void sleep;
