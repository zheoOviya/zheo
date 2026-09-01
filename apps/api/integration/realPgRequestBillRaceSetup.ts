// ============================================================
// I7.2-B — Real-PG fixture + two independent requestBill backends
// (SETUP PROOF ONLY — no race execution).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillRaceSetup.ts
//
// PROVES (and only claims) the SETUP precondition for the upcoming
// I7.2 concurrent-requestBill race:
//   - database safety gate (dine_itrack/dine_itrack)
//   - minimum valid real-PG fixture: owner + active restaurant + eligible
//     table + ACTIVE dining session + exactly one non-CANCELLED billable
//     order + exactly one immutable item snapshot
//   - fresh committed reads: session ACTIVE, bill_requested_at NULL,
//     SessionBill count = 0, BRING_BILL count = 0
//   - two GENUINELY INDEPENDENT requestBill backends (distinct pools /
//     distinct DrizzleDineInTransactionPort instances / same sessionId /
//     same legitimate owner caller / NO getDineInTransactionPort() singleton),
//     with distinct pg_backend_pid values proven
//   - NO race execution: requestBill A and B are NOT invoked, no locks are
//     intentionally held, no bill/request artifacts are created
//   - fixture is fully cleaned up after the setup proof (option A); the next
//     checkpoint recreates it deterministically
//
// NO production code is touched. No concurrency. No lock gating.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleDineInTransactionPort } from "../src/repositories/drizzle/dineInTransactionPort";
import { DiningSessionService } from "../src/services/dineInSession";

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
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ASSERT OK [${label}]: ${JSON.stringify(actual)}`);
}

function assertNum(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${expected}, got ${actual}`);
  }
  console.log(`  ASSERT OK [${label}]: ${actual}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAIL [${label}]`);
  console.log(`  ASSERT OK [${label}]: true`);
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
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

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrack8A" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrack8B" });
  const poolC = new Pool({ connectionString: url, application_name: "itrack8C" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-rb2-${randomUUID().replace(/-/g, "")}`;
  const label = `I7.2-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I7.2-Item-${randomUUID().slice(0, 8)}`;

  const idleBefore = await countIdleInTransaction(poolC);
  console.log(`IDLE-IN-TRANSACTION (before): ${idleBefore} (expect 0)`);
  assertNum(idleBefore, 0, "idle-in-transaction before (expect 0)");

  try {
    // ---- database safety gate ----
    const safety = (await poolC.query(
      "SELECT current_database() AS db, current_user AS usr",
    )).rows[0] as { db: string; usr: string };
    if (safety.db !== "dine_itrack" || safety.usr !== "dine_itrack") {
      throw new Error(
        `SAFETY REFUSED: expected dine_itrack/dine_itrack, got ${safety.db}/${safety.usr}. Refusing shared/fallback DB.`,
      );
    }
    console.log(`SAFETY OK: ${safety.db}/${safety.usr}`);

    // ---- minimum valid real-PG fixture (no domain services) ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I7.2-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
      VALUES (${tableId}, ${restaurantId}, ${label}, ${tableToken})
    `);
    await setup.execute(sql`
      INSERT INTO menu_items (id, restaurant_id, name, price)
      VALUES (${menuItemId}, ${restaurantId}, ${itemName}, ${menuPrice})
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionId}, ${restaurantId}, ${tableId}, ${ownerUserId}, 'ACTIVE')
    `);
    await setup.execute(sql`
      INSERT INTO dine_in_orders (id, session_id, restaurant_id, placed_by, status, total_amount)
      VALUES (${orderId}, ${sessionId}, ${restaurantId}, ${ownerUserId}, 'PLACED', ${orderTotal})
    `);
    await setup.execute(sql`
      INSERT INTO dine_in_order_items
        (id, dine_in_order_id, restaurant_id, menu_item_id, name, base_price, quantity, item_subtotal)
      VALUES (${randomUUID()}, ${orderId}, ${restaurantId}, ${menuItemId}, ${itemName}, ${menuPrice}, ${menuQty}, ${itemSubtotal})
    `);
    console.log("FIXTURE CREATED: owner + active restaurant + eligible table + ACTIVE session + exactly 1 non-CANCELLED (PLACED) billable order + 1 item snapshot");

    // ---- fresh committed reads: setup preconditions ----
    const sessionRow = (await setup.execute(
      sql`SELECT status, bill_requested_at FROM dining_sessions WHERE id = ${sessionId}`,
    )).rows[0] as { status: string; bill_requested_at: string | null };
    const billCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const bringBillCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests
           WHERE session_id = ${sessionId} AND request_type = 'BRING_BILL'`,
    )).rows[0]?.c as number;
    assertEqual(sessionRow.status, "ACTIVE", "fresh read: session ACTIVE");
    assertEqual(sessionRow.bill_requested_at, null, "fresh read: bill_requested_at NULL");
    assertNum(billCount, 0, "fresh read: SessionBill count 0");
    assertNum(bringBillCount, 0, "fresh read: BRING_BILL count 0");
    console.log("FIXTURE PRECONDITION OK: ACTIVE session / bill_requested_at NULL / 0 SessionBill / 0 BRING_BILL");

    // ---- two independent requestBill backends (setup only) ----
    const portA = new DrizzleDineInTransactionPort(drizzle(poolA) as unknown as DrizzleDb);
    const portB = new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb);
    const serviceA = new DiningSessionService(portA, async () => {});
    const serviceB = new DiningSessionService(portB, async () => {});

    // Prove each backend uses a distinct real PG connection (backend PID).
    const clientA = await poolA.connect();
    const clientB = await poolB.connect();
    try {
      const pidA = (await clientA.query("SELECT pg_backend_pid() AS pid, current_setting('application_name') AS app")).rows[0] as { pid: number; app: string };
      const pidB = (await clientB.query("SELECT pg_backend_pid() AS pid, current_setting('application_name') AS app")).rows[0] as { pid: number; app: string };
      assertEqual(pidA.app, "itrack8A", "backend A application_name");
      assertEqual(pidB.app, "itrack8B", "backend B application_name");
      assertTrue(pidA.pid !== pidB.pid, `backend pids distinct (A=${pidA.pid}, B=${pidB.pid})`);
      console.log(`TWO INDEPENDENT BACKENDS: pg_backend_pid A=${pidA.pid} (itrack8A), B=${pidB.pid} (itrack8B) — distinct real PG connections`);
    } finally {
      clientA.release();
      clientB.release();
    }

    // Backends target the SAME session with the SAME legitimate owner/caller.
    assertTrue(portA !== portB, "distinct DrizzleDineInTransactionPort instances (no shared port/singleton)");
    assertTrue(serviceA !== serviceB, "distinct DiningSessionService instances");
    console.log(`RACE TARGET READY: backend A + backend B both target sessionId=${sessionId} with caller=${ownerUserId} (same owner) — NOT invoked`);

    // ---- NO race execution ----
    // requestBill is intentionally never called on A or B. No locks are held:
    // clients were released with no transaction open. No artifacts created.
    const idleMid = await countIdleInTransaction(poolC);
    assertNum(idleMid, 0, "no locks held: idle-in-transaction 0");
    const billMid = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const bringMid = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertNum(billMid, 0, "no artifact created: SessionBill count 0");
    assertNum(bringMid, 0, "no artifact created: BRING_BILL count 0");
    console.log("NO RACE EXECUTION: requestBill A not invoked, requestBill B not invoked, no locks held, no bill/request artifacts created");

    // ---- cleanup (option A: full cleanup; next checkpoint recreates) ----
    await setup.execute(sql`DELETE FROM dine_in_order_items WHERE dine_in_order_id = ${orderId}`);
    await setup.execute(sql`DELETE FROM dine_in_orders WHERE id = ${orderId}`);
    await setup.execute(sql`DELETE FROM dining_sessions WHERE id = ${sessionId}`);
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE id = ${tableId}`);
    await setup.execute(sql`DELETE FROM menu_items WHERE id = ${menuItemId}`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id = ${restaurantId}`);
    await setup.execute(sql`DELETE FROM users WHERE id = ${ownerUserId}`);
    console.log("CLEANUP: fixture fully removed (option A)");

    const idleFinal = await countIdleInTransaction(poolC);
    assertNum(idleFinal, 0, "idle-in-transaction final (expect 0)");
    const tables = (await poolC.query(
      "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )).rows[0] as { c: number };
    const migrations = (await poolC.query(
      `SELECT count(*)::int AS c FROM drizzle."__drizzle_migrations"`,
    )).rows[0] as { c: number };
    assertNum(tables.c, 23, "public tables (expect 23)");
    assertNum(migrations.c, 15, "migration rows (expect 15)");

    console.log("I7.2-B SETUP PROOF OK");
  } finally {
    await poolA.end();
    await poolB.end();
    await poolC.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
