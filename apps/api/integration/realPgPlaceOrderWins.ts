// ============================================================
// I3.1 — Real-PG service-interleaving proof: placeOrder-wins ordering.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgPlaceOrderWins.ts
//
// PROVES (and only claims) the SINGLE placeOrder-wins interleaving:
//   - DineInOrderService.placeOrder and DiningSessionService.requestBill run
//     on two GENUINELY INDEPENDENT PG transaction backends (dedicated
//     pools/ports per service, no shared singleton port).
//   - placeOrder acquires the REAL dining_sessions FOR UPDATE row lock first.
//   - requestBill, started after placeOrder holds the lock, BLOCKS on the
//     same row (pg_stat_activity wait_event_type=Lock; pg_locks
//     transactionid ShareLock granted=false) until placeOrder commits.
//   - after placeOrder commits (order PLACED + session OPEN->ACTIVE), the
//     blocking requestBill proceeds and bills the COMMITTED immutable order
//     snapshot (SessionBill totals equal the persisted order item subtotals).
//   - the artifacts are NOT duplicated: exactly 1 order, 1 order item,
//     1 frozen SessionBill, 1 BRING_BILL service request.
//
// Deterministic control (no arbitrary race sleeps): a TEST-ONLY wrapper
// around the REAL placeOrder transaction injects a deferred gate AFTER the
// real session lock is acquired (A locks -> signal -> B starts and blocks ->
// A completes writes -> A commits -> B proceeds). NO production code is
// touched; the gate lives entirely inside this harness.
//
// DOES NOT claim (I3.2+ territory): requestBill-wins ordering, cancellation/
// advance interleavings, deadlock-freedom, rollback semantics, general MVCC
// correctness, durable event ordering / outbox / exactly-once.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  TransactionalDiningSessionRepository,
} from "../src/repositories/dineInContracts";
import { DrizzleDineInTransactionPort } from "../src/repositories/drizzle/dineInTransactionPort";
import { DrizzleCatalogRepository } from "../src/repositories/catalogRepository";
import { DineInOrderService } from "../src/services/dineInOrder";
import { DiningSessionService } from "../src/services/dineInSession";
import type { DineInEventFactEmitter } from "../src/services/dineInEventEmitter";
import type { MutationOutcome } from "../src/services/dineInSession";
import type { PlaceOrderResult } from "../src/services/dineInOrder";
import type { RequestBillResult } from "../src/services/dineInSession";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Single short event-loop checkpoint: has the promise settled (resolved or rejected)? */
async function isSettled<T>(p: Promise<T>): Promise<boolean> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(75);
  return settled;
}

interface ActivityRow {
  wait_event_type: string | null;
  wait_event: string | null;
  state: string | null;
}

async function backendActivity(
  pool: Pool,
  appName: string,
): Promise<ActivityRow> {
  const rows = (await pool.query(
    `SELECT wait_event_type, wait_event, state
       FROM pg_stat_activity
      WHERE application_name = $1 AND datname = current_database()`,
    [appName],
  )).rows as ActivityRow[];
  return rows[0] ?? { wait_event_type: null, wait_event: null, state: null };
}

async function backendPid(pool: Pool, appName: string): Promise<number | null> {
  const rows = (await pool.query(
    `SELECT pid FROM pg_stat_activity
      WHERE application_name = $1 AND datname = current_database()`,
    [appName],
  )).rows as { pid: number }[];
  return rows[0]?.pid ?? null;
}

/** Poll until the named backend shows wait_event_type='Lock' (deterministic gate). */
async function waitUntilBlocked(
  pool: Pool,
  appName: string,
  timeoutMs: number,
): Promise<ActivityRow> {
  const deadline = Date.now() + timeoutMs;
  let last: ActivityRow = { wait_event_type: null, wait_event: null, state: null };
  while (Date.now() < deadline) {
    last = await backendActivity(pool, appName);
    if (last.wait_event_type === "Lock") return last;
    await sleep(20);
  }
  return last;
}

interface LockRow {
  pid: number;
  locktype: string;
  mode: string;
  granted: boolean;
}

async function observeLocks(pool: Pool, aPid: number, bPid: number): Promise<LockRow[]> {
  const rows = (await pool.query(
    `SELECT pid, locktype, mode, granted
       FROM pg_locks
      WHERE pid IN ($1, $2)
        AND locktype IN ('relation', 'tuple', 'transactionid')
      ORDER BY pid, locktype, mode`,
    [aPid, bPid],
  )).rows as LockRow[];
  return rows;
}

async function countIdleInTransaction(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  )).rows as { c: number }[];
  return rows[0]?.c ?? -1;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ASSERT OK [${label}]: ${JSON.stringify(actual)}`);
}

function assertNum(actual: number, expected: number, label: string, eps = 0.001): void {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${expected}, got ${actual}`);
  }
  console.log(`  ASSERT OK [${label}]: ${actual}`);
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// ============================================================
// Test-only deferred gate inserted AFTER the real session FOR UPDATE lock.
// NO production code is modified; the real service + real repos run intact.
// ============================================================

interface SessionLockGate {
  onSessionLocked: (sessionId: string) => Promise<void>;
}

/** Wraps the real repo, intercepting ONLY lockById to insert the gate. */
function gateSessionLock(
  inner: TransactionalDiningSessionRepository,
  gate: SessionLockGate,
): TransactionalDiningSessionRepository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "lockById") {
        return async (sessionId: string) => {
          const row = await target.lockById(sessionId);
          if (row) await gate.onSessionLocked(sessionId);
          return row;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class GatedDineInTransactionPort implements DineInTransactionPort {
  constructor(
    private readonly inner: DineInTransactionPort,
    private readonly gate: SessionLockGate,
  ) {}

  async runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      const gated: DineInTransactionRepos = {
        ...repos,
        diningSessions: gateSessionLock(repos.diningSessions, this.gate),
      };
      return fn(gated);
    });
  }
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackPA" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrackPB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackPC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const tableToken = `itrack-pow-${randomUUID().replace(/-/g, "")}`;
  const label = `I3.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i3.1-${randomUUID()}`;

  // Immutable fixture catalog price. placeOrder prices from the catalog;
  // requestBill later freezes the bill from the COMMITTED order snapshot.
  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const foodSubtotal = round2(itemSubtotal);
  const gstFood = round2(foodSubtotal * 0.05);
  const billTotal = round2(foodSubtotal + gstFood);

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

    // ---- minimal Dine-In fixture (no domain services) ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I3.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
      VALUES (${tableId}, ${restaurantId}, ${label}, ${tableToken})
    `);
    await setup.execute(sql`
      INSERT INTO menu_items (id, restaurant_id, name, price)
      VALUES (${menuItemId}, ${restaurantId}, ${`I3.1-Item-${randomUUID().slice(0, 8)}`}, ${menuPrice})
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionId}, ${restaurantId}, ${tableId}, ${ownerUserId}, 'OPEN')
    `);
    console.log(
      "FIXTURE OK: user + restaurant + table + menu_item + OPEN session inserted",
    );
    console.log(
      `  EXPECTED BILL COHERENCE: item_subtotal=${itemSubtotal} food_subtotal=${foodSubtotal} gst_food=${gstFood} total=${billTotal}`,
    );

    // ---- two genuinely independent service backends ----
    // portA (gated): DineInOrderService. portB: DiningSessionService.
    // Distinct Drizzle transaction ports over distinct single-client pools —
    // NO shared `getDineInTransactionPort()` singleton.
    const catalogRepo = new DrizzleCatalogRepository(drizzle(poolC) as unknown as DrizzleDb);
    // Test-safe no-op emitter: this proof claims NO durable event ordering.
    const noopEmitter: DineInEventFactEmitter = async () => {};

    const aLocked = deferred();
    const releaseA = deferred();
    const gate: SessionLockGate = {
      onSessionLocked: async () => {
        aLocked.resolve();
        await releaseA.promise;
      },
    };

    const gatedPort = new GatedDineInTransactionPort(
      new DrizzleDineInTransactionPort(drizzle(poolA) as unknown as DrizzleDb),
      gate,
    );
    const serviceAGated = new DineInOrderService(gatedPort, catalogRepo);
    const serviceB = new DiningSessionService(
      new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb),
      noopEmitter,
    );

    // ============================================================
    // STEP 1 — placeOrder acquires the session FOR UPDATE lock and pauses.
    // ============================================================
    const placeOrderPromise = serviceAGated.placeOrder({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
      items: [{ menu_item_id: menuItemId, quantity: menuQty }],
    });
    await withTimeout(aLocked.promise, 10000, "placeOrder never acquired the session lock");
    const aPid = await backendPid(poolC, "itrackPA");
    const aAct = await backendActivity(poolC, "itrackPA");
    if (!aPid) throw new Error("INDEPENDENCE FAILED: could not identify placeOrder backend (itrackPA)");
    console.log(
      `[C] placeOrder holds session lock; backend pid=${aPid} state=${aAct.state} (paused inside real tx)`,
    );

    // ============================================================
    // STEP 2 — requestBill starts and BLOCKS on the same row.
    // ============================================================
    const requestBillPromise = serviceB.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });

    const bAct = await waitUntilBlocked(poolC, "itrackPB", 8000);
    const bPid = await backendPid(poolC, "itrackPB");
    if (!bPid) throw new Error("INDEPENDENCE FAILED: could not identify requestBill backend (itrackPB)");
    if (aPid === bPid) throw new Error(`INDEPENDENCE FAILED: same backend pid ${aPid}`);
    console.log(
      `[C] requestBill backend blocked: wait_event_type=${bAct.wait_event_type} wait_event=${bAct.wait_event} state=${bAct.state} pid=${bPid}`,
    );

    const bSettled = await isSettled(requestBillPromise);
    if (bSettled) {
      throw new Error("REQUESTBILL BLOCKING FAILED: requestBill settled while placeOrder held the session lock");
    }
    console.log("REQUESTBILL BLOCKING: requestBill pending (not resolved, no error) while placeOrder holds");

    const locks = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while requestBill blocked: ${JSON.stringify(locks)}`);

    const aXid = locks.find((l) => l.pid === aPid && l.locktype === "transactionid" && l.mode === "ExclusiveLock");
    const bXid = locks.find((l) => l.pid === bPid && l.locktype === "transactionid" && l.mode === "ShareLock");
    const bTuple = locks.find((l) => l.pid === bPid && l.locktype === "tuple" && l.mode === "AccessExclusiveLock");
    if (!aXid || !aXid.granted) throw new Error("LOCK ASSERT FAIL: placeOrder lacks granted transactionid ExclusiveLock");
    if (!bXid || bXid.granted) throw new Error("LOCK ASSERT FAIL: requestBill must show NOT-granted transactionid ShareLock");
    if (!bTuple || !bTuple.granted) throw new Error("LOCK ASSERT FAIL: requestBill must hold granted tuple AccessExclusiveLock");
    console.log(
      "LOCK ASSERT: placeOrder transactionid ExclusiveLock granted=true; requestBill transactionid ShareLock granted=false + tuple AccessExclusiveLock granted=true",
    );

    // ============================================================
    // STEP 3 — release placeOrder: writes + COMMIT.
    // ============================================================
    releaseA.resolve();
    const aOutcome = await withTimeout(
      placeOrderPromise as Promise<MutationOutcome<PlaceOrderResult>>,
      10000,
      "placeOrder did not complete after release",
    );
    if (aOutcome.kind !== "NEW_MUTATION") {
      throw new Error(`placeOrder unexpected outcome kind: ${aOutcome.kind}`);
    }
    const placed = aOutcome.value.order;
    console.log(
      `[A] placeOrder committed: order id=${placed.id.slice(0, 8)} status=${placed.status} items=${placed.items.length} total=${placed.total_amount}`,
    );
    assertEqual(placed.status, "PLACED", "placeOrder order status");
    assertEqual(placed.items.length, 1, "placeOrder item count");
    assertNum(placed.items[0]!.item_subtotal, itemSubtotal, "placed item_subtotal");

    // ============================================================
    // STEP 4 — requestBill proceeds after placeOrder commit.
    // ============================================================
    const bOutcome = await withTimeout(
      requestBillPromise as Promise<MutationOutcome<RequestBillResult>>,
      10000,
      "requestBill did not complete after placeOrder commit",
    );
    if (bOutcome.kind !== "NEW_MUTATION") {
      throw new Error(`requestBill unexpected outcome kind: ${bOutcome.kind}`);
    }
    const { session, bill, bringBillRequest } = bOutcome.value;
    console.log(
      `[B] requestBill committed: session=${session.status} bill_total=${bill.total_amount} bringBill=${bringBillRequest?.request_type}`,
    );
    assertEqual(session.status, "BILL_REQUESTED", "session status after requestBill");
    assertNum(Number(bill.food_subtotal), foodSubtotal, "bill food_subtotal");
    assertNum(Number(bill.gst_food), gstFood, "bill gst_food");
    assertNum(Number(bill.total_amount), billTotal, "bill total_amount");
    assertEqual(bringBillRequest?.request_type, "BRING_BILL", "BRING_BILL service request type");

    // ============================================================
    // STEP 5 — fresh committed reads: no duplication, bill coherence.
    // ============================================================
    const orderRows = (await poolC.query(
      `SELECT id, status, total_amount FROM dine_in_orders WHERE session_id = $1`,
      [sessionId],
    )).rows as { id: string; status: string; total_amount: string }[];
    assertEqual(orderRows.length, 1, "dine_in_orders cardinality");
    assertEqual(orderRows[0]!.status, "PLACED", "persisted order status");

    const itemRows = (await poolC.query(
      `SELECT dine_in_order_id, quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = $1`,
      [orderRows[0]!.id],
    )).rows as { dine_in_order_id: string; quantity: number; item_subtotal: string }[];
    assertEqual(itemRows.length, 1, "dine_in_order_items cardinality");
    assertEqual(itemRows[0]!.quantity, menuQty, "persisted order item quantity");
    assertNum(Number(itemRows[0]!.item_subtotal), itemSubtotal, "persisted order item_subtotal");

    const billRows = (await poolC.query(
      `SELECT food_subtotal, gst_food, gst_packaging, packaging_fee, total_amount, frozen_at
         FROM session_bills WHERE session_id = $1`,
      [sessionId],
    )).rows as {
      food_subtotal: string;
      gst_food: string;
      gst_packaging: string;
      packaging_fee: string;
      total_amount: string;
      frozen_at: string | null;
    }[];
    assertEqual(billRows.length, 1, "session_bills cardinality");
    const billRow = billRows[0]!;
    assertNum(Number(billRow.food_subtotal), foodSubtotal, "bill food_subtotal (persisted)");
    assertNum(Number(billRow.gst_food), gstFood, "bill gst_food (persisted)");
    assertNum(Number(billRow.packaging_fee), 0, "bill packaging_fee (persisted)");
    assertNum(Number(billRow.gst_packaging), 0, "bill gst_packaging (persisted)");
    assertNum(Number(billRow.total_amount), billTotal, "bill total_amount (persisted)");
    if (!billRow.frozen_at) throw new Error("ASSERT FAIL: bill frozen_at must be set");

    // Bill coherence against the persisted order snapshot:
    const orderTotal = Number(orderRows[0]!.total_amount);
    assertNum(orderTotal, billTotal, "order.total_amount equals bill.total_amount");
    assertNum(Number(billRow.food_subtotal), itemSubtotal, "bill food_subtotal equals single order item subtotal");

    const srRows = (await poolC.query(
      `SELECT request_type, status FROM service_requests WHERE session_id = $1`,
      [sessionId],
    )).rows as { request_type: string; status: string }[];
    assertEqual(srRows.length, 1, "service_requests cardinality");
    assertEqual(srRows[0]!.request_type, "BRING_BILL", "BRING_BILL request_type");
    assertEqual(srRows[0]!.status, "PENDING", "BRING_BILL status");

    const sessionRows = (await poolC.query(
      `SELECT status, bill_requested_at FROM dining_sessions WHERE id = $1`,
      [sessionId],
    )).rows as { status: string; bill_requested_at: string | null }[];
    assertEqual(sessionRows[0]!.status, "BILL_REQUESTED", "persisted session status");
    if (!sessionRows[0]!.bill_requested_at) throw new Error("ASSERT FAIL: bill_requested_at must be set");

    const idle = await countIdleInTransaction(poolC);
    console.log(`IDLE-IN-TRANSACTION: ${idle} (expect 0)`);
    if (idle !== 0) throw new Error(`CLEANUP FAILED: ${idle} idle-in-transaction sessions left`);

    console.log("I3.1 PLACEORDER-WINS PROOF OK");
  } catch (err) {
    console.error("I3.1 PROOF FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // ---- fixture cleanup (FK-safe order) on a fresh connection ----
    const cleanupPool = new Pool({ connectionString: url });
    try {
      await cleanupPool.query(
        `DELETE FROM dine_in_order_items
          WHERE dine_in_order_id IN (SELECT id FROM dine_in_orders WHERE session_id = $1)`,
        [sessionId],
      );
      await cleanupPool.query(`DELETE FROM dine_in_orders WHERE session_id = $1`, [sessionId]);
      await cleanupPool.query(`DELETE FROM session_bills WHERE session_id = $1`, [sessionId]);
      await cleanupPool.query(`DELETE FROM service_requests WHERE session_id = $1`, [sessionId]);
      await cleanupPool.query(`DELETE FROM staff_assignments WHERE session_id = $1`, [sessionId]);
      await cleanupPool.query(`DELETE FROM dining_sessions WHERE id = $1`, [sessionId]);
      await cleanupPool.query(`DELETE FROM restaurant_tables WHERE id = $1`, [tableId]);
      await cleanupPool.query(`DELETE FROM menu_items WHERE id = $1`, [menuItemId]);
      await cleanupPool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
      await cleanupPool.query(`DELETE FROM users WHERE id = $1`, [ownerUserId]);
      console.log("FIXTURE CLEANUP OK");
      const idleFinal = await countIdleInTransaction(cleanupPool);
      console.log(`IDLE-IN-TRANSACTION (final): ${idleFinal} (expect 0)`);
      const tables = (await cleanupPool.query(
        `SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = 'public'`,
      )).rows as { c: number }[];
      console.log(`PUBLIC TABLES: ${tables[0]?.c} (expect 23)`);
      const migs = (await cleanupPool.query(
        `SELECT count(*)::int AS c FROM drizzle."__drizzle_migrations"`,
      )).rows as { c: number }[];
      console.log(`MIGRATION ROWS: ${migs[0]?.c} (expect 15)`);
    } catch (e) {
      console.error("FIXTURE CLEANUP WARNING:", e instanceof Error ? e.message : e);
    }
    await cleanupPool.end();
    await poolA.end();
    await poolB.end();
    await poolC.end();
  }
}

main();
