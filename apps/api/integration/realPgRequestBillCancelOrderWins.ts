// ============================================================
// I4.2 — Real-PG service-interleaving proof: requestBill-wins over final cancel.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillCancelOrderWins.ts
//
// PROVES (and only claims) the SINGLE requestBill-wins interleaving for the
// final billable order:
//   - DiningSessionService.requestBill and DineInOrderService.cancelOrder run
//     on two GENUINELY INDEPENDENT PG transaction backends (dedicated
//     pools/ports per service, no shared singleton port).
//   - requestBill acquires the REAL dining_sessions FOR UPDATE row lock first.
//   - cancelOrder, started after requestBill holds the lock, BLOCKS on the
//     same row (pg_stat_activity wait_event_type=Lock; pg_locks
//     transactionid ShareLock granted=false) until requestBill commits.
//   - after requestBill commits BILL_REQUESTED + frozen SessionBill +
//     BRING_BILL, the blocking cancelOrder revalidates the now-frozen session
//     and is REJECTED with the accepted existing error contract BILL_FROZEN
//     (409) — the order stays uncancelled, cancellation audit fields stay
//     NULL, and the frozen bill/BRING_BILL artifacts are unchanged.
//
// Deterministic control (no arbitrary race sleeps): a TEST-ONLY wrapper
// around the REAL requestBill transaction injects a deferred gate AFTER the
// real session lock is acquired (requestBill locks -> signal -> cancelOrder
// starts and blocks -> requestBill freezes + commits -> cancelOrder proceeds).
// NO production code is touched; the gate lives entirely inside this harness.
//
// DOES NOT claim (I5+ territory): cancel-wins ordering (I4.1), advance/cancel
// interleavings, deadlock-freedom, rollback semantics, general MVCC
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
import { AppError } from "../src/middleware/envelope";
import type { DineInEventFactEmitter } from "../src/services/dineInEventEmitter";
import type { MutationOutcome } from "../src/services/dineInSession";
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

async function backendActivity(pool: Pool, appName: string): Promise<ActivityRow> {
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

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackYA" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrackYB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackYC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-rbc-${randomUUID().replace(/-/g, "")}`;
  const label = `I4.2-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i4.2-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const foodSubtotal = round2(itemSubtotal);
  const gstFood = round2(foodSubtotal * 0.05);
  const billTotal = round2(foodSubtotal + gstFood);
  const itemName = `I4.2-Item-${randomUUID().slice(0, 8)}`;

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

    // ---- minimal Dine-In fixture (no domain services): ACTIVE session with
    // exactly ONE non-CANCELLED cancellable order (PLACED) + item snapshot ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I4.2-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
      VALUES (${orderId}, ${sessionId}, ${restaurantId}, ${ownerUserId}, 'PLACED', ${billTotal})
    `);
    await setup.execute(sql`
      INSERT INTO dine_in_order_items
        (id, dine_in_order_id, restaurant_id, menu_item_id, name, base_price, quantity, item_subtotal)
      VALUES (${randomUUID()}, ${orderId}, ${restaurantId}, ${menuItemId}, ${itemName}, ${menuPrice}, ${menuQty}, ${itemSubtotal})
    `);
    console.log(
      "FIXTURE OK: user + restaurant + table + menu_item + ACTIVE session + exactly ONE PLACED cancellable order snapshot",
    );

    // ---- two genuinely independent service backends ----
    // portA (gated) -> DiningSessionService (requestBill).
    // portB -> DineInOrderService (cancelOrder).
    const catalogRepo = new DrizzleCatalogRepository(drizzle(poolC) as unknown as DrizzleDb);
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
    const serviceA = new DiningSessionService(gatedPort, noopEmitter);
    const serviceB = new DineInOrderService(
      new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb),
      catalogRepo,
    );

    // ============================================================
    // STEP 1 — requestBill acquires the session FOR UPDATE lock and pauses.
    // ============================================================
    const requestBillPromise = serviceA.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });
    await withTimeout(aLocked.promise, 10000, "requestBill never acquired the session lock");
    const aPid = await backendPid(poolC, "itrackYA");
    const aAct = await backendActivity(poolC, "itrackYA");
    if (!aPid) throw new Error("INDEPENDENCE FAILED: could not identify requestBill backend (itrackYA)");
    console.log(
      `[C] requestBill holds session lock; backend pid=${aPid} state=${aAct.state} (paused inside real tx)`,
    );

    // ============================================================
    // STEP 2 — cancelOrder starts and BLOCKS on the same row.
    // ============================================================
    const cancelPromise = serviceB.cancelOrder({
      order_id: orderId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });

    const bAct = await waitUntilBlocked(poolC, "itrackYB", 8000);
    const bPid = await backendPid(poolC, "itrackYB");
    if (!bPid) throw new Error("INDEPENDENCE FAILED: could not identify cancelOrder backend (itrackYB)");
    if (aPid === bPid) throw new Error(`INDEPENDENCE FAILED: same backend pid ${aPid}`);
    console.log(
      `[C] cancelOrder backend blocked: wait_event_type=${bAct.wait_event_type} wait_event=${bAct.wait_event} state=${bAct.state} pid=${bPid}`,
    );

    const bSettled = await isSettled(cancelPromise);
    if (bSettled) {
      throw new Error("CANCEL BLOCKING FAILED: cancelOrder settled while requestBill held the session lock");
    }
    console.log("CANCEL BLOCKING: cancelOrder pending (not resolved, no error) while requestBill holds");

    const locks = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while cancelOrder blocked: ${JSON.stringify(locks)}`);

    const aXid = locks.find((l) => l.pid === aPid && l.locktype === "transactionid" && l.mode === "ExclusiveLock");
    const bXid = locks.find((l) => l.pid === bPid && l.locktype === "transactionid" && l.mode === "ShareLock");
    const bTuple = locks.find((l) => l.pid === bPid && l.locktype === "tuple" && l.mode === "AccessExclusiveLock");
    if (!aXid || !aXid.granted) throw new Error("LOCK ASSERT FAIL: requestBill lacks granted transactionid ExclusiveLock");
    if (!bXid || bXid.granted) throw new Error("LOCK ASSERT FAIL: cancelOrder must show NOT-granted transactionid ShareLock");
    if (!bTuple || !bTuple.granted) throw new Error("LOCK ASSERT FAIL: cancelOrder must hold granted tuple AccessExclusiveLock");
    console.log(
      "LOCK ASSERT: requestBill transactionid ExclusiveLock granted=true; cancelOrder transactionid ShareLock granted=false + tuple AccessExclusiveLock granted=true",
    );

    // ============================================================
    // STEP 3 — release requestBill: bill freeze + COMMIT.
    // ============================================================
    releaseA.resolve();
    const aOutcome = await withTimeout(
      requestBillPromise as Promise<MutationOutcome<RequestBillResult>>,
      10000,
      "requestBill did not complete after release",
    );
    if (aOutcome.kind !== "NEW_MUTATION") {
      throw new Error(`requestBill unexpected outcome kind: ${aOutcome.kind}`);
    }
    const { session, bill, bringBillRequest } = aOutcome.value;
    console.log(
      `[A] requestBill committed: session=${session.status} bill_id=${bill.id.slice(0, 8)} total=${bill.total_amount} bringBill=${bringBillRequest?.request_type}`,
    );
    assertEqual(session.status, "BILL_REQUESTED", "session status after requestBill");
    assertNum(Number(bill.food_subtotal), foodSubtotal, "bill food_subtotal (frozen from pre-existing snapshot)");
    assertNum(Number(bill.gst_food), gstFood, "bill gst_food");
    assertNum(Number(bill.total_amount), billTotal, "bill total_amount");
    assertEqual(bringBillRequest?.request_type, "BRING_BILL", "BRING_BILL service request type");
    const frozenBillId = bill.id;
    const bringBillId = bringBillRequest?.id ?? null;
    if (!bringBillId) throw new Error("ASSERT FAIL: bringBillRequest id missing");

    // ============================================================
    // STEP 4 — cancelOrder proceeds after requestBill commit and is REJECTED.
    // ============================================================
    let cancelError: AppError | null = null;
    let cancelResult: unknown = null;
    try {
      cancelResult = await withTimeout(
        cancelPromise,
        10000,
        "cancelOrder did not complete after requestBill commit",
      );
    } catch (err) {
      cancelError = err instanceof AppError ? err : null;
      if (!cancelError) {
        throw new Error(`cancelOrder rejected with unexpected error type: ${String(err)}`);
      }
    }
    if (cancelError === null) {
      throw new Error(`cancelOrder unexpectedly SUCCEEDED after bill freeze: ${JSON.stringify(cancelResult)}`);
    }
    console.log(
      `[B] cancelOrder rejected post-freeze: code=${cancelError.code} status=${cancelError.status}`,
    );
    assertEqual(cancelError.code, "BILL_FROZEN", "cancelOrder rejection code (accepted existing contract)");
    assertEqual(cancelError.status, 409, "cancelOrder rejection status");

    // ============================================================
    // STEP 5 — fresh committed reads: order uncancelled, frozen artifacts unchanged.
    // ============================================================
    const sessionRows = (await poolC.query(
      `SELECT status, bill_requested_at FROM dining_sessions WHERE id = $1`,
      [sessionId],
    )).rows as { status: string; bill_requested_at: string | null }[];
    assertEqual(sessionRows[0]!.status, "BILL_REQUESTED", "persisted session status");
    if (!sessionRows[0]!.bill_requested_at) throw new Error("ASSERT FAIL: bill_requested_at must be set");

    const orderRows = (await poolC.query(
      `SELECT id, status, cancelled_at, cancelled_by FROM dine_in_orders WHERE session_id = $1`,
      [sessionId],
    )).rows as { id: string; status: string; cancelled_at: Date | null; cancelled_by: string | null }[];
    assertEqual(orderRows.length, 1, "dine_in_orders cardinality (exactly 1)");
    assertEqual(orderRows[0]!.id, orderId, "original order remains (not replaced)");
    assertEqual(orderRows[0]!.status, "PLACED", "order status remains original (uncancelled)");
    assertEqual(orderRows[0]!.cancelled_at, null, "cancelled_at remains NULL");
    assertEqual(orderRows[0]!.cancelled_by, null, "cancelled_by remains NULL");

    const itemRows = (await poolC.query(
      `SELECT dine_in_order_id, quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = $1`,
      [orderId],
    )).rows as { dine_in_order_id: string; quantity: number; item_subtotal: string }[];
    assertEqual(itemRows.length, 1, "dine_in_order_items cardinality (snapshot still attached)");
    assertEqual(itemRows[0]!.quantity, menuQty, "order item quantity");
    assertNum(Number(itemRows[0]!.item_subtotal), itemSubtotal, "order item_subtotal");

    const billRows = (await poolC.query(
      `SELECT id, food_subtotal, gst_food, gst_packaging, packaging_fee, total_amount, frozen_at
         FROM session_bills WHERE session_id = $1`,
      [sessionId],
    )).rows as {
      id: string;
      food_subtotal: string;
      gst_food: string;
      gst_packaging: string;
      packaging_fee: string;
      total_amount: string;
      frozen_at: string | null;
    }[];
    assertEqual(billRows.length, 1, "session_bills cardinality");
    assertEqual(billRows[0]!.id, frozenBillId, "same SessionBill id (unchanged by failed cancel)");
    assertNum(Number(billRows[0]!.food_subtotal), foodSubtotal, "frozen bill food_subtotal unchanged");
    assertNum(Number(billRows[0]!.gst_food), gstFood, "frozen bill gst_food unchanged");
    assertNum(Number(billRows[0]!.packaging_fee), 0, "frozen bill packaging_fee unchanged");
    assertNum(Number(billRows[0]!.gst_packaging), 0, "frozen bill gst_packaging unchanged");
    assertNum(Number(billRows[0]!.total_amount), billTotal, "frozen bill total_amount unchanged");
    if (!billRows[0]!.frozen_at) throw new Error("ASSERT FAIL: bill frozen_at must be set");

    const srRows = (await poolC.query(
      `SELECT id, request_type, status FROM service_requests WHERE session_id = $1`,
      [sessionId],
    )).rows as { id: string; request_type: string; status: string }[];
    assertEqual(srRows.length, 1, "service_requests cardinality");
    assertEqual(srRows[0]!.id, bringBillId, "same BRING_BILL id (unchanged by failed cancel)");
    assertEqual(srRows[0]!.request_type, "BRING_BILL", "BRING_BILL request_type");
    assertEqual(srRows[0]!.status, "PENDING", "BRING_BILL status");

    const idle = await countIdleInTransaction(poolC);
    console.log(`IDLE-IN-TRANSACTION: ${idle} (expect 0)`);
    if (idle !== 0) throw new Error(`CLEANUP FAILED: ${idle} idle-in-transaction sessions left`);

    console.log("I4.2 REQUESTBILL-WINS OVER CANCEL PROOF OK");
  } catch (err) {
    console.error("I4.2 PROOF FAILED:", err instanceof Error ? err.message : err);
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
