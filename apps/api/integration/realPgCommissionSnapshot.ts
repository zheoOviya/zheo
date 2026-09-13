/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// COMMISSION-SNAPSHOT-MIGRATION-A3 — REAL-POSTGRES SNAPSHOT PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, applies the real migrations and drives the REAL
// DrizzleOrderRepository so the immutable commission snapshot and the legacy
// NULL recompute path are proven against actual PG storage.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/commission_a3_p1_run" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=commission_a3 \
//     pnpm exec tsx apps/api/integration/realPgCommissionSnapshot.ts
//
// PROVES (and only claims):
//   P0 migration/schema smoke: both nullable snapshot columns exist, no default
//   P1 new >200 order persists/re-reads 0.08 + exact amount
//   P2 boundary 200 -> 0/0, 201 -> 0.08/16.08 (canonical + legacy recompute)
//   P3 legacy NULL row recomputes canonically; DB stays NULL after read
//   P4 restaurant rate change after create does not alter the snapshot
//   P5 admin commission source == settlement commission for the same order
//
// DOES NOT claim: payment / settlement authority, EventBus durability, or any
// change to historical (pre-snapshot) rows (they are never rewritten).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type { CreateOrderInput, OrderDTO } from "../src/repositories/orderRepository";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "commission_a3";
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

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const pool = new Pool({ connectionString: DATABASE_URL, max: 8, application_name: "commissionA3" });
  const db = drizzle(pool) as unknown as DrizzleDb;

  const { DrizzleOrderRepository } = await import(
    "../src/repositories/drizzle/drizzleOrderRepository"
  );
  const { calculatePriceBreakdown, computeCommission } = await import("../src/services/pricing");
  const { computeSettlementLine } = await import("../src/services/settlement");

  const orderRepo = new DrizzleOrderRepository(db);

  // ---------- environment + isolation ----------
  const versionRes = await pool.query<{ version: string; db: string; user: string }>(
    "select version() as version, current_database() as db, current_user as user",
  );
  const version = versionRes.rows[0]!.version;
  const dbName = versionRes.rows[0]!.db;
  const postgresConfirmed = /PostgreSQL/i.test(version);
  const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

  console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
  console.log(`ISOLATION_MODE=${ISOLATION_MODE}`);
  console.log(`RUN_TAG=${TAG}`);
  console.log(`DATABASE_NAME=${dbName}`);
  console.log(`PG_VERSION=${version.split(" on ")[0]}`);
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check("P0_ISOLATION_GUARD", isolationOk, `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`);
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await pool.end();
    process.exit(1);
  }

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await pool.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };
  const countIdleInTransaction = async (): Promise<number> =>
    count(
      "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      [],
    );

  const userIds: string[] = [];
  const restaurantIds: string[] = [];
  const menuItemIds: string[] = [];
  const committedOrderIds: string[] = [];
  const rawOrderIds: string[] = [];

  async function seedBase(): Promise<{ userId: string; restaurantId: string; menuItemId: string }> {
    const userId = randomUUID();
    const restaurantId = randomUUID();
    const menuItemId = randomUUID();
    await pool.query("insert into users (id, phone) values ($1,$2)", [
      userId,
      `cs-${TAG}-${userId.slice(0, 8)}`,
    ]);
    await pool.query(
      "insert into restaurants (id, owner_id, name, gst_number, fssai_license) values ($1,$2,$3,$4,$5)",
      [
        restaurantId,
        userId,
        `Commission ${TAG}`,
        `GST-${TAG}-${restaurantId.slice(0, 8)}`,
        `FSSAI-${TAG}-${restaurantId.slice(0, 8)}`,
      ],
    );
    await pool.query(
      "insert into menu_items (id, restaurant_id, name, price) values ($1,$2,$3,$4)",
      [menuItemId, restaurantId, `Commission Item ${TAG}`, "220.00"],
    );
    userIds.push(userId);
    restaurantIds.push(restaurantId);
    menuItemIds.push(menuItemId);
    return { userId, restaurantId, menuItemId };
  }

  function createInput(base: {
    userId: string;
    restaurantId: string;
    menuItemId: string;
  }): CreateOrderInput {
    const lines = [
      {
        menu_item_id: base.menuItemId,
        name: `Commission Item ${TAG}`,
        base_price: 220,
        quantity: 1,
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
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === line.menu_item_id)?.item_subtotal ?? 0,
      })),
      breakdown,
    };
  }

  const rawCommission = async (
    orderId: string,
  ): Promise<{ rate: string | null; amount: string | null } | null> => {
    const r = await pool.query<{ commission_rate: string | null; commission_amount: string | null }>(
      "select commission_rate, commission_amount from orders where id=$1",
      [orderId],
    );
    return r.rows[0] ?? null;
  };

  /** Harness-only: insert a legacy (pre-snapshot) order with NULL commission. */
  async function seedLegacyOrder(
    base: { userId: string; restaurantId: string },
    totalAmount: string,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into orders (id, user_id, restaurant_id, total_amount, status) values ($1,$2,$3,$4,'PICKED_UP')",
      [id, base.userId, base.restaurantId, totalAmount],
    );
    rawOrderIds.push(id);
    return id;
  }

  const base = await seedBase();

  // ============================================================
  // P0 — SCHEMA SMOKE: nullable snapshot columns, no default
  // ============================================================
  const columnRes = await pool.query<{
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    "select column_name, is_nullable, column_default from information_schema.columns where table_name='orders' and column_name in ('commission_rate','commission_amount') order by column_name",
  );
  const cols = columnRes.rows;
  const p0Ok =
    cols.length === 2 &&
    cols.every((c) => c.is_nullable === "YES" && c.column_default === null);
  check(
    "P0_SNAPSHOT_COLUMNS_NULLABLE_NO_DEFAULT",
    p0Ok,
    cols.map((c) => `${c.column_name}:nullable=${c.is_nullable},default=${c.column_default ?? "NULL"}`).join(" | "),
  );
  for (const c of cols) console.log(`P0_COLUMN=${c.column_name} NULLABLE=${c.is_nullable} DEFAULT=${c.column_default ?? "NULL"}`);

  // ============================================================
  // P1 — NEW >200 ORDER PERSISTS/RE-READS 0.08 + EXACT AMOUNT
  // ============================================================
  const p1 = await orderRepo.create(createInput(base));
  committedOrderIds.push(p1.id);
  const p1Raw = await rawCommission(p1.id);
  const p1Loaded = await orderRepo.getById(p1.id);
  const p1Canonical = computeCommission(p1.total_amount);
  check(
    "P1_NEW_ORDER_PERSISTS_SNAPSHOT",
    p1.total_amount > 200 &&
      p1Loaded?.commission_rate === 0.08 &&
      p1Loaded.commission_amount === p1Canonical.amount &&
      Number(p1Raw?.commission_rate) === 0.08 &&
      Number(p1Raw?.commission_amount) === p1Canonical.amount,
    `total=${p1.total_amount} dtoRate=${p1Loaded?.commission_rate} dtoAmount=${p1Loaded?.commission_amount} dbRate=${p1Raw?.commission_rate} dbAmount=${p1Raw?.commission_amount}`,
  );
  console.log(`P1_ORDER=${p1.id} P1_AMOUNT=${p1Canonical.amount}`);

  // ============================================================
  // P2 — BOUNDARY 200 -> 0/0, 201 -> .08/16.08
  // ============================================================
  const canonical200 = computeCommission(200);
  const canonical201 = computeCommission(201);
  const legacy200 = await seedLegacyOrder(base, "200.00");
  const legacy201 = await seedLegacyOrder(base, "201.00");
  const loaded200 = await orderRepo.getById(legacy200);
  const loaded201 = await orderRepo.getById(legacy201);
  check(
    "P2_BOUNDARY_200_0_201_8",
    canonical200.rate === 0 &&
      canonical200.amount === 0 &&
      canonical201.rate === 0.08 &&
      canonical201.amount === 16.08 &&
      loaded200?.commission_rate === 0 &&
      loaded200.commission_amount === 0 &&
      loaded201?.commission_rate === 0.08 &&
      loaded201.commission_amount === 16.08,
    `c200=${JSON.stringify(canonical200)} c201=${JSON.stringify(canonical201)} r200=${loaded200?.commission_rate}/${loaded200?.commission_amount} r201=${loaded201?.commission_rate}/${loaded201?.commission_amount}`,
  );
  console.log(`P2_200=${loaded200?.commission_amount} P2_201=${loaded201?.commission_amount}`);

  // ============================================================
  // P3 — LEGACY NULL RECOMPUTES; DB REMAINS NULL AFTER READ
  // ============================================================
  const legacy300 = await seedLegacyOrder(base, "300.00");
  const beforeRead = await rawCommission(legacy300);
  const loaded300 = await orderRepo.getById(legacy300);
  const afterRead = await rawCommission(legacy300);
  const expected300 = computeCommission(300);
  check(
    "P3_LEGACY_NULL_RECOMPUTES_NO_MUTATION",
    beforeRead?.commission_rate === null &&
      beforeRead?.commission_amount === null &&
      loaded300?.commission_rate === expected300.rate &&
      loaded300.commission_amount === expected300.amount &&
      afterRead?.commission_rate === null &&
      afterRead?.commission_amount === null,
    `before=${beforeRead?.commission_rate}/${beforeRead?.commission_amount} loaded=${loaded300?.commission_rate}/${loaded300?.commission_amount} after=${afterRead?.commission_rate}/${afterRead?.commission_amount}`,
  );
  console.log(`P3_ORDER=${legacy300} P3_LOADED=${loaded300?.commission_amount} P3_DB_AFTER=${afterRead?.commission_amount ?? "NULL"}`);

  // ============================================================
  // P4 — RESTAURANT RATE CHANGE DOES NOT ALTER SNAPSHOT
  // ============================================================
  await pool.query("update restaurants set commission_rate='0.50' where id=$1", [base.restaurantId]);
  const p4 = await orderRepo.create(createInput(base));
  committedOrderIds.push(p4.id);
  const p4AfterRateChange = await orderRepo.getById(p4.id);
  await pool.query("update restaurants set commission_rate='0.99' where id=$1", [base.restaurantId]);
  const p4Reread = await orderRepo.getById(p4.id);
  const p4Canonical = computeCommission(p4.total_amount);
  check(
    "P4_RESTAURANT_RATE_NOT_MONEY_INPUT",
    p4AfterRateChange?.commission_rate === 0.08 &&
      p4AfterRateChange.commission_amount === p4Canonical.amount &&
      p4Reread?.commission_rate === 0.08 &&
      p4Reread.commission_amount === p4Canonical.amount,
    `rateDuringCreate=0.50 rateAfterCreate=0.99 snapshot=${p4Reread?.commission_rate}/${p4Reread?.commission_amount}`,
  );
  console.log(`P4_SNAPSHOT=${p4Reread?.commission_rate}/${p4Reread?.commission_amount}`);

  // ============================================================
  // P5 — ADMIN COMMISSION SOURCE == SETTLEMENT COMMISSION
  // ============================================================
  const p5Dto: OrderDTO = (await orderRepo.getById(p1.id))!;
  const settlement = computeSettlementLine(p5Dto);
  // Admin `/revenue` + `/vendors/metrics` sum the DTO's commission_amount.
  const adminSource = p5Dto.commission_amount;
  const p5Raw = await rawCommission(p1.id);
  check(
    "P5_ADMIN_SETTLEMENT_SAME_COMMISSION",
    adminSource === settlement.commission_amount &&
      Number(p5Raw?.commission_amount) === settlement.commission_amount &&
      settlement.commission_rate === 0.08,
    `admin=${adminSource} settlement=${settlement.commission_amount} db=${p5Raw?.commission_amount}`,
  );
  console.log(`P5_ADMIN=${adminSource} P5_SETTLEMENT=${settlement.commission_amount} P5_DB=${p5Raw?.commission_amount}`);

  // ============================================================
  // concurrency + idle verdict
  // ============================================================
  const idleBefore = await countIdleInTransaction();
  console.log(`IDLE_IN_TRANSACTION=${idleBefore} (expect 0)`);
  check("NO_IDLE_IN_TRANSACTION", idleBefore === 0, `idle=${idleBefore}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from order_items where order_id = any($1::uuid[])", [committedOrderIds]],
    ["delete from orders where id = any($1::uuid[])", [committedOrderIds]],
    ["delete from orders where id = any($1::uuid[])", [rawOrderIds]],
    ["delete from menu_items where id = any($1::uuid[])", [menuItemIds]],
    ["delete from restaurants where id = any($1::uuid[])", [restaurantIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await pool.query(sqlText, params as any[]);
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

  await pool.end();
  console.log("OPEN_DB_CONNECTIONS=CLOSED");

  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
