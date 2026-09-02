// ============================================================
// DINE-OPS1.2 — VENDOR DINE-IN KITCHEN QUEUE READ MODEL (real PG).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgVendorKitchenQueue.ts
//
// PROVES (and only claims) the repository-layer public read model
// DrizzleDineInOrderRepository.getKitchenQueueByRestaurant against real PG:
//   - actionable statuses only (PLACED / PREPARING / READY_TO_SERVE)
//   - SERVED / CANCELLED excluded
//   - oldest actionable order first (created_at ascending)
//   - restaurant scoping (zero cross-restaurant leakage)
//   - table id/label derived from dining_sessions -> restaurant_tables
//     (never client-supplied; only restaurant_id is input)
//   - item name is the persisted historical snapshot (no catalog join)
//   - empty restaurant -> []
//   - READ-ONLY: no transaction, no FOR UPDATE, no mutation; no
//     idle-in-transaction left behind.
//
// BOUNDARIES: repository layer only. NO service method, NO route, NO vendor
// UI, NO realtime, NO schema/migration, NO auth/security/CI changes.
// No commit.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleDineInOrderRepository } from "../src/repositories/drizzle/dineInRepositories";
import type { DineInKitchenOrderDTO } from "../src/repositories/dineInContracts";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable I-track DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `ASSERT FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ASSERT OK [${label}]: ${JSON.stringify(actual)}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAIL [${label}]`);
  console.log(`  ASSERT OK [${label}]: true`);
}

async function countIdleInTransaction(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  )).rows as { c: number }[];
  return rows[0]?.c ?? -1;
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, application_name: "itrackOps1_2" });

  const ownerUserId = randomUUID();
  const guestUserId = randomUUID();
  const restaurantAId = randomUUID();
  const restaurantBId = randomUUID();
  const tableAId = randomUUID();
  const tableBId = randomUUID();
  const sessionAId = randomUUID();
  const sessionBId = randomUUID();
  const menuItemAId = randomUUID();
  const menuItemBId = randomUUID();
  const orderPlacedId = randomUUID();
  const orderPreparingId = randomUUID();
  const orderReadyId = randomUUID();
  const orderServedId = randomUUID();
  const orderCancelledId = randomUUID();
  const orderOtherRestId = randomUUID();

  const idleBefore = await countIdleInTransaction(pool);
  console.log(`IDLE-IN-TRANSACTION (before): ${idleBefore} (expect 0)`);
  assertEqual(idleBefore, 0, "idle-in-transaction before (expect 0)");

  try {
    const safety = (await pool.query(
      "SELECT current_database() AS db, current_user AS usr",
    )).rows[0] as { db: string; usr: string };
    if (safety.db !== "dine_itrack" || safety.usr !== "dine_itrack") {
      throw new Error(
        `SAFETY REFUSED: expected dine_itrack/dine_itrack, got ${safety.db}/${safety.usr}.`,
      );
    }
    console.log(`SAFETY OK: ${safety.db}/${safety.usr}`);

    const setup = drizzle(pool);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`ops12-owner-${randomUUID()}`})`,
    );
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${guestUserId}, ${`ops12-guest-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantAId}, ${ownerUserId}, ${`Ops1.2-A-${randomUUID().slice(0, 8)}`}, ${`GST12A${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAI12A${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantBId}, ${ownerUserId}, ${`Ops1.2-B-${randomUUID().slice(0, 8)}`}, ${`GST12B${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAI12B${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableAId}, ${restaurantAId}, ${"T-A1"}, ${`ops12-token-A-${randomUUID().replace(/-/g, "")}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableBId}, ${restaurantBId}, ${"T-B1"}, ${`ops12-token-B-${randomUUID().replace(/-/g, "")}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionAId}, ${restaurantAId}, ${tableAId}, ${guestUserId}, 'ACTIVE')
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionBId}, ${restaurantBId}, ${tableBId}, ${guestUserId}, 'ACTIVE')
    `);
    await setup.execute(sql`
      INSERT INTO menu_items (id, restaurant_id, name, price, is_available)
      VALUES (${menuItemAId}, ${restaurantAId}, ${"Biryani A"}, 220, true)
    `);
    await setup.execute(sql`
      INSERT INTO menu_items (id, restaurant_id, name, price, is_available)
      VALUES (${menuItemBId}, ${restaurantBId}, ${"Bowl B"}, 180, true)
    `);

    // createdAt strings chosen to verify oldest-first ordering.
    const mkOrder = (id: string, restaurantId: string, sessionId: string, status: string, createdAt: string) =>
      setup.execute(sql`
        INSERT INTO dine_in_orders (id, session_id, restaurant_id, placed_by, status, total_amount, created_at, updated_at)
        VALUES (${id}, ${sessionId}, ${restaurantId}, ${guestUserId}, ${status}, 462.00, ${createdAt}, ${createdAt})
      `);
    await mkOrder(orderPreparingId, restaurantAId, sessionAId, "PREPARING", "2026-08-24T10:01:00.000Z");
    await mkOrder(orderReadyId, restaurantAId, sessionAId, "READY_TO_SERVE", "2026-08-24T10:02:00.000Z");
    await mkOrder(orderPlacedId, restaurantAId, sessionAId, "PLACED", "2026-08-24T10:03:00.000Z");
    await mkOrder(orderServedId, restaurantAId, sessionAId, "SERVED", "2026-08-24T10:04:00.000Z");
    await mkOrder(orderCancelledId, restaurantAId, sessionAId, "CANCELLED", "2026-08-24T10:05:00.000Z");
    await mkOrder(orderOtherRestId, restaurantBId, sessionBId, "PLACED", "2026-08-24T10:06:00.000Z");

    const mkItem = (id: string, orderId: string, restaurantId: string, menuItemId: string, name: string, subtotal: number) =>
      setup.execute(sql`
        INSERT INTO dine_in_order_items (id, dine_in_order_id, restaurant_id, menu_item_id, name, base_price, quantity, customizations, customization_total, item_subtotal)
        VALUES (${id}, ${orderId}, ${restaurantId}, ${menuItemId}, ${name}, 220.00, 2, '[]', 0.00, ${subtotal})
      `);
    await mkItem(randomUUID(), orderPreparingId, restaurantAId, menuItemAId, "Biryani A", 440.00);
    await mkItem(randomUUID(), orderReadyId, restaurantAId, menuItemAId, "Biryani A", 440.00);
    await mkItem(randomUUID(), orderPlacedId, restaurantAId, menuItemAId, "Biryani A", 440.00);
    await mkItem(randomUUID(), orderServedId, restaurantAId, menuItemAId, "Biryani A", 440.00);
    await mkItem(randomUUID(), orderCancelledId, restaurantAId, menuItemAId, "Biryani A", 440.00);
    await mkItem(randomUUID(), orderOtherRestId, restaurantBId, menuItemBId, "Bowl B", 360.00);
    console.log("FIXTURE OK: 3 actionable + 2 terminal orders (restaurant A), 1 actionable (restaurant B)");

    const repo = new DrizzleDineInOrderRepository(setup as unknown as DrizzleDb);

    // ---- restaurant A: actionable only, oldest first ----
    const queueA: DineInKitchenOrderDTO[] = await repo.getKitchenQueueByRestaurant(restaurantAId);
    assertEqual(
      queueA.map((o) => o.id),
      [orderPreparingId, orderReadyId, orderPlacedId],
      "restaurant A kitchen queue ids (oldest first, actionable only)",
    );
    assertEqual(
      queueA.map((o) => o.status),
      ["PREPARING", "READY_TO_SERVE", "PLACED"],
      "restaurant A statuses in created_at order",
    );
    assertTrue(!queueA.some((o) => o.id === orderServedId || o.id === orderCancelledId), "SERVED/CANCELLED excluded");
    assertEqual(
      queueA[0].table,
      { id: tableAId, label: "T-A1" },
      "table id/label derived from session -> table store",
    );
    assertEqual(queueA[0].session_id, sessionAId, "session id carried");
    assertEqual(queueA[0].total_amount, 462, "authoritative total_amount (numeric)");
    assertEqual(
      queueA[0].items,
      [
        {
          menu_item_id: menuItemAId,
          name: "Biryani A",
          quantity: 2,
          item_subtotal: 440,
        },
      ],
      "item = persisted name snapshot (no catalog join)",
    );
    console.log(`QUEUE A OK: ${JSON.stringify(queueA)}`);

    // ---- restaurant B: only its own order ----
    const queueB: DineInKitchenOrderDTO[] = await repo.getKitchenQueueByRestaurant(restaurantBId);
    assertEqual(
      queueB.map((o) => o.id),
      [orderOtherRestId],
      "restaurant B kitchen queue ids (zero cross-restaurant leakage)",
    );
    assertEqual(queueB[0].table, { id: tableBId, label: "T-B1" }, "restaurant B table derived");
    console.log(`QUEUE B OK: ${JSON.stringify(queueB)}`);

    // ---- empty restaurant -> [] ----
    const emptyId = randomUUID();
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${emptyId}, ${ownerUserId}, ${`Ops1.2-Empty-${randomUUID().slice(0, 8)}`}, ${`GST12E${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAI12E${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    const queueEmpty: DineInKitchenOrderDTO[] = await repo.getKitchenQueueByRestaurant(emptyId);
    assertEqual(queueEmpty, [], "restaurant with no orders -> []");

    // ---- READ-ONLY / no mutation proof ----
    const orderRows = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM dine_in_orders WHERE restaurant_id IN (${restaurantAId}, ${restaurantBId})`,
    )).rows[0]?.c as number;
    const sessionRows = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM dining_sessions WHERE id IN (${sessionAId}, ${sessionBId})`,
    )).rows[0]?.c as number;
    assertEqual(orderRows, 6, "no mutation: 6 dine_in_orders unchanged");
    assertEqual(sessionRows, 2, "no mutation: 2 dining_sessions unchanged");
    console.log("READ-ONLY OK: kitchen-queue read created no rows and changed no rows");

    // ---- cleanup (reverse dependency order) ----
    await setup.execute(sql`DELETE FROM dine_in_order_items WHERE dine_in_order_id IN (${orderPlacedId}, ${orderPreparingId}, ${orderReadyId}, ${orderServedId}, ${orderCancelledId}, ${orderOtherRestId})`);
    await setup.execute(sql`DELETE FROM dine_in_orders WHERE id IN (${orderPlacedId}, ${orderPreparingId}, ${orderReadyId}, ${orderServedId}, ${orderCancelledId}, ${orderOtherRestId})`);
    await setup.execute(sql`DELETE FROM dining_sessions WHERE id IN (${sessionAId}, ${sessionBId})`);
    await setup.execute(sql`DELETE FROM menu_items WHERE id IN (${menuItemAId}, ${menuItemBId})`);
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE id IN (${tableAId}, ${tableBId})`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id IN (${restaurantAId}, ${restaurantBId}, ${emptyId})`);
    await setup.execute(sql`DELETE FROM users WHERE id IN (${ownerUserId}, ${guestUserId})`);
    console.log("FIXTURE CLEANUP OK");

    const idleFinal = await countIdleInTransaction(pool);
    assertEqual(idleFinal, 0, "idle-in-transaction final (expect 0)");
    const tables = (await pool.query(
      "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )).rows[0] as { c: number };
    const migrations = (await pool.query(
      `SELECT count(*)::int AS c FROM drizzle."__drizzle_migrations"`,
    )).rows[0] as { c: number };
    assertEqual(tables.c, 23, "public tables (expect 23)");
    assertEqual(migrations.c, 15, "migration rows (expect 15)");

    console.log("DINE-OPS1.2 VENDOR DINE-IN KITCHEN QUEUE READ MODEL PROOF OK");
  } finally {
    for (const p of [pool]) {
      p.end().catch(() => {});
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
