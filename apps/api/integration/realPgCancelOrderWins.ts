// ============================================================
// I4.1 — Real-PG service-interleaving proof: cancelOrder-wins (final order).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgCancelOrderWins.ts
//
// PROVES (and only claims) the SINGLE cancel-wins interleaving for the FINAL
// billable order:
//   - DineInOrderService.cancelOrder and DiningSessionService.requestBill run
//     on two GENUINELY INDEPENDENT PG transaction backends (dedicated
//     pools/ports per service, no shared singleton port).
//   - cancelOrder acquires the REAL dining_sessions FOR UPDATE row lock first.
//   - requestBill, started after cancelOrder holds the lock, BLOCKS on the
//     same row (pg_stat_activity wait_event_type=Lock; pg_locks
//     transactionid ShareLock granted=false) until cancelOrder commits.
//   - after cancelOrder commits (final order CANCELLED + ACTIVE->OPEN session
//     compensation), the blocking requestBill observes the reopened OPEN
//     session and is REJECTED with the accepted existing error contract
//     SESSION_NOT_BILLABLE (400) — NO SessionBill, NO BRING_BILL, no
//     self-heal back to ACTIVE.
//   - cancellation audit metadata (cancelled_by/cancelled_at) is persisted
//     once by the accepted service behavior; a post-race cancel retry is
//     IDEMPOTENT (order stays CANCELLED, same cancelled_at, no second
//     compensation).
//
// Deterministic control (no arbitrary race sleeps): a TEST-ONLY wrapper
// around the REAL cancelOrder transaction injects a deferred gate AFTER the
// real session lock is acquired (cancel locks -> signal -> requestBill starts
// and blocks -> cancel writes + commits -> requestBill proceeds). NO
// production code is touched; the gate lives entirely inside this harness.
//
// DOES NOT claim (I4.2+ territory): requestBill-wins ordering, advance/cancel
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
import type { CancelOrderResult } from "../src/services/dineInOrder";

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

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackXA" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrackXB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackXC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-cow-${randomUUID().replace(/-/g, "")}`;
  const label = `I4.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i4.1-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I4.1-Item-${randomUUID().slice(0, 8)}`;

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
    // exactly ONE non-CANCELLED billable order (PLACED) + one item snapshot ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I4.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
    console.log(
      "FIXTURE OK: user + restaurant + table + menu_item + ACTIVE session + exactly ONE PLACED order snapshot",
    );

    // ---- two genuinely independent service backends ----
    // portA (gated) -> DineInOrderService (cancelOrder).
    // portB -> DiningSessionService (requestBill).
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
    const serviceA = new DineInOrderService(gatedPort, catalogRepo);
    const serviceB = new DiningSessionService(
      new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb),
      noopEmitter,
    );

    // ============================================================
    // STEP 1 — cancelOrder acquires the session FOR UPDATE lock and pauses.
    // ============================================================
    const cancelPromise = serviceA.cancelOrder({
      order_id: orderId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });
    await withTimeout(aLocked.promise, 10000, "cancelOrder never acquired the session lock");
    const aPid = await backendPid(poolC, "itrackXA");
    const aAct = await backendActivity(poolC, "itrackXA");
    if (!aPid) throw new Error("INDEPENDENCE FAILED: could not identify cancelOrder backend (itrackXA)");
    console.log(
      `[C] cancelOrder holds session lock; backend pid=${aPid} state=${aAct.state} (paused inside real tx)`,
    );

    // ============================================================
    // STEP 2 — requestBill starts and BLOCKS on the same row.
    // ============================================================
    const requestBillPromise = serviceB.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });

    const bAct = await waitUntilBlocked(poolC, "itrackXB", 8000);
    const bPid = await backendPid(poolC, "itrackXB");
    if (!bPid) throw new Error("INDEPENDENCE FAILED: could not identify requestBill backend (itrackXB)");
    if (aPid === bPid) throw new Error(`INDEPENDENCE FAILED: same backend pid ${aPid}`);
    console.log(
      `[C] requestBill backend blocked: wait_event_type=${bAct.wait_event_type} wait_event=${bAct.wait_event} state=${bAct.state} pid=${bPid}`,
    );

    const bSettled = await isSettled(requestBillPromise);
    if (bSettled) {
      throw new Error("REQUESTBILL BLOCKING FAILED: requestBill settled while cancelOrder held the session lock");
    }
    console.log("REQUESTBILL BLOCKING: requestBill pending (not resolved, no error) while cancelOrder holds");

    const locks = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while requestBill blocked: ${JSON.stringify(locks)}`);

    const aXid = locks.find((l) => l.pid === aPid && l.locktype === "transactionid" && l.mode === "ExclusiveLock");
    const bXid = locks.find((l) => l.pid === bPid && l.locktype === "transactionid" && l.mode === "ShareLock");
    const bTuple = locks.find((l) => l.pid === bPid && l.locktype === "tuple" && l.mode === "AccessExclusiveLock");
    if (!aXid || !aXid.granted) throw new Error("LOCK ASSERT FAIL: cancelOrder lacks granted transactionid ExclusiveLock");
    if (!bXid || bXid.granted) throw new Error("LOCK ASSERT FAIL: requestBill must show NOT-granted transactionid ShareLock");
    if (!bTuple || !bTuple.granted) throw new Error("LOCK ASSERT FAIL: requestBill must hold granted tuple AccessExclusiveLock");
    console.log(
      "LOCK ASSERT: cancelOrder transactionid ExclusiveLock granted=true; requestBill transactionid ShareLock granted=false + tuple AccessExclusiveLock granted=true",
    );

    // ============================================================
    // STEP 3 — release cancelOrder: final-order cancellation + ACTIVE->OPEN + COMMIT.
    // ============================================================
    releaseA.resolve();
    const aOutcome = await withTimeout(
      cancelPromise as Promise<MutationOutcome<CancelOrderResult>>,
      10000,
      "cancelOrder did not complete after release",
    );
    if (aOutcome.kind !== "NEW_MUTATION") {
      throw new Error(`cancelOrder unexpected outcome kind: ${aOutcome.kind}`);
    }
    const cancelled = aOutcome.value.order;
    console.log(
      `[A] cancelOrder committed: order status=${cancelled.status} cancelled_by=${cancelled.cancelled_by?.slice(0, 8)}... cancelled_at=${cancelled.cancelled_at}`,
    );
    assertEqual(cancelled.status, "CANCELLED", "cancelOrder order status");
    assertEqual(cancelled.cancelled_by, ownerUserId, "cancelOrder cancelled_by");
    if (!cancelled.cancelled_at) throw new Error("ASSERT FAIL: cancelled_at must be set");
    const firstCancelledAtEpoch = Date.parse(cancelled.cancelled_at);

    // ============================================================
    // STEP 4 — requestBill proceeds after cancelOrder commit and is REJECTED.
    // ============================================================
    let requestBillError: AppError | null = null;
    let requestBillResult: unknown = null;
    try {
      requestBillResult = await withTimeout(
        requestBillPromise,
        10000,
        "requestBill did not complete after cancelOrder commit",
      );
    } catch (err) {
      requestBillError = err instanceof AppError ? err : null;
      if (!requestBillError) {
        throw new Error(`requestBill rejected with unexpected error type: ${String(err)}`);
      }
    }
    if (requestBillError === null) {
      throw new Error(`requestBill unexpectedly SUCCEEDED on reopened OPEN session: ${JSON.stringify(requestBillResult)}`);
    }
    console.log(
      `[B] requestBill rejected post-cancel: code=${requestBillError.code} status=${requestBillError.status}`,
    );
    assertEqual(requestBillError.code, "SESSION_NOT_BILLABLE", "requestBill rejection code (accepted existing contract)");
    assertEqual(requestBillError.status, 400, "requestBill rejection status");

    // ============================================================
    // STEP 5 — fresh committed reads: cancel result + no bill artifacts.
    // ============================================================
    const sessionRows = (await poolC.query(
      `SELECT status, bill_requested_at FROM dining_sessions WHERE id = $1`,
      [sessionId],
    )).rows as { status: string; bill_requested_at: string | null }[];
    assertEqual(sessionRows[0]!.status, "OPEN", "session status after final cancellation");
    assertEqual(sessionRows[0]!.bill_requested_at, null, "no bill_requested_at (no freeze ever)");

    const orderRows = (await poolC.query(
      `SELECT id, status, cancelled_by, cancelled_at FROM dine_in_orders WHERE session_id = $1`,
      [sessionId],
    )).rows as { id: string; status: string; cancelled_by: string; cancelled_at: Date }[];
    assertEqual(orderRows.length, 1, "dine_in_orders cardinality (exactly 1)");
    assertEqual(orderRows[0]!.id, orderId, "only the pre-existing order remains");
    assertEqual(orderRows[0]!.status, "CANCELLED", "persisted order status");
    assertEqual(orderRows[0]!.cancelled_by, ownerUserId, "persisted cancelled_by");
    const persistedCancelledEpoch = Date.parse(orderRows[0]!.cancelled_at.toISOString());
    if (Math.abs(persistedCancelledEpoch - firstCancelledAtEpoch) > 100) {
      throw new Error("ASSERT FAIL: persisted cancelled_at differs from service result");
    }
    console.log("  ASSERT OK [persisted cancelled_at == service cancelled_at]: true");

    const itemRows = (await poolC.query(
      `SELECT dine_in_order_id, quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = $1`,
      [orderId],
    )).rows as { dine_in_order_id: string; quantity: number; item_subtotal: string }[];
    assertEqual(itemRows.length, 1, "dine_in_order_items cardinality (snapshot still attached)");
    assertEqual(itemRows[0]!.quantity, menuQty, "order item quantity");
    assertNum(Number(itemRows[0]!.item_subtotal), itemSubtotal, "order item_subtotal");

    const billRows = (await poolC.query(
      `SELECT count(*)::int AS c FROM session_bills WHERE session_id = $1`,
      [sessionId],
    )).rows as { c: number }[];
    assertEqual(billRows[0]!.c, 0, "session_bills cardinality (0 — no bill frozen)");

    const srRows = (await poolC.query(
      `SELECT count(*)::int AS c FROM service_requests WHERE session_id = $1`,
      [sessionId],
    )).rows as { c: number }[];
    assertEqual(srRows[0]!.c, 0, "service_requests cardinality (0 — no BRING_BILL)");

    // ============================================================
    // STEP 6 — CANCELLATION AUDIT: one post-race cancel retry is idempotent.
    // ============================================================
    const retryOutcome = await withTimeout(
      serviceA.cancelOrder({
        order_id: orderId,
        caller_user_id: ownerUserId,
        correlation_id: correlationId,
      }) as Promise<MutationOutcome<CancelOrderResult>>,
      10000,
      "cancel retry did not complete",
    );
    if (retryOutcome.kind !== "IDEMPOTENT_NO_MUTATION") {
      throw new Error(`cancel retry unexpected outcome kind: ${retryOutcome.kind}`);
    }
    assertEqual(retryOutcome.value.order.status, "CANCELLED", "retry keeps order CANCELLED");
    console.log("  ASSERT OK [cancel retry is IDEMPOTENT_NO_MUTATION]: true");

    const retryOrderRows = (await poolC.query(
      `SELECT status, cancelled_at FROM dine_in_orders WHERE id = $1`,
      [orderId],
    )).rows as { status: string; cancelled_at: Date }[];
    assertEqual(retryOrderRows[0]!.status, "CANCELLED", "retry did not alter order status");
    const retryCancelledEpoch = Date.parse(retryOrderRows[0]!.cancelled_at.toISOString());
    if (retryCancelledEpoch !== persistedCancelledEpoch) {
      throw new Error("ASSERT FAIL: retry regenerated cancelled_at (metadata was rewritten)");
    }
    console.log("  ASSERT OK [retry kept same cancelled_at, no metadata rewrite]: true");

    const retrySessionRows = (await poolC.query(
      `SELECT status FROM dining_sessions WHERE id = $1`,
      [sessionId],
    )).rows as { status: string }[];
    assertEqual(retrySessionRows[0]!.status, "OPEN", "no second compensation on retry (session stays OPEN)");
    const retryOrderCount = (await poolC.query(
      `SELECT count(*)::int AS c FROM dine_in_orders WHERE session_id = $1`,
      [sessionId],
    )).rows as { c: number }[];
    assertEqual(retryOrderCount[0]!.c, 1, "no duplicate/replacement order on retry");

    const idle = await countIdleInTransaction(poolC);
    console.log(`IDLE-IN-TRANSACTION: ${idle} (expect 0)`);
    if (idle !== 0) throw new Error(`CLEANUP FAILED: ${idle} idle-in-transaction sessions left`);

    console.log("I4.1 CANCEL-WINS PROOF OK");
  } catch (err) {
    console.error("I4.1 PROOF FAILED:", err instanceof Error ? err.message : err);
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
