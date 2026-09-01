// ============================================================
// I5.1 — Real-PG service-interleaving proof: advanceOrder-wins (PREPARING->READY_TO_SERVE).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgAdvanceOrderWins.ts
//
// PROVES (and only claims) the SINGLE advance-wins interleaving:
//   - Two DineInOrderService operations (advanceOrder and cancelOrder) run on
//     two GENUINELY INDEPENDENT PG transaction backends (dedicated
//     pools/ports per service, no shared singleton port).
//   - advanceOrder acquires the REAL dining_sessions FOR UPDATE row lock AND
//     the REAL order row lock first (frozen lock order: session -> order).
//   - cancelOrder, started after advanceOrder holds both locks, BLOCKS on the
//     session row (pg_stat_activity wait_event_type=Lock; pg_locks
//     transactionid ShareLock granted=false) until advanceOrder commits.
//   - after advanceOrder commits PREPARING->READY_TO_SERVE, the blocking
//     cancelOrder revalidates the committed order state and is REJECTED with
//     the accepted existing error contract ORDER_NOT_CANCELLABLE (409) — no
//     cancellation metadata written, order stays READY_TO_SERVE, no
//     billing/request artifact created.
//
// Deterministic control (no arbitrary race sleeps): a TEST-ONLY wrapper
// around the REAL advanceOrder transaction injects a deferred gate AFTER both
// real locks are acquired (advance locks session -> advance locks order ->
// signal -> cancelOrder starts and blocks -> advance writes + commits ->
// cancelOrder proceeds). NO production code is touched; the gate lives
// entirely inside this harness.
//
// DOES NOT claim (I5.2+ territory): cancel-wins ordering, deadlock-freedom,
// rollback semantics, general MVCC correctness, durable event ordering /
// outbox / exactly-once.
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
  TransactionalDineInOrderRepository,
} from "../src/repositories/dineInContracts";
import { DrizzleDineInTransactionPort } from "../src/repositories/drizzle/dineInTransactionPort";
import { DrizzleCatalogRepository } from "../src/repositories/catalogRepository";
import { DineInOrderService } from "../src/services/dineInOrder";
import { AppError } from "../src/middleware/envelope";
import type { MutationOutcome } from "../src/services/dineInSession";
import type { AdvanceOrderResult, CancelOrderResult } from "../src/services/dineInOrder";

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
// Test-only deferred gate inserted AFTER the real session AND order
// FOR UPDATE locks. NO production code is modified; the real service + real
// repos run intact.
// ============================================================

interface LockGate {
  onSessionLocked: (sessionId: string) => Promise<void>;
  onOrderLocked: (orderId: string) => Promise<void>;
}

/** Wraps the real repo, intercepting ONLY lockById to insert the gate. */
function gateSessionLock(
  inner: TransactionalDiningSessionRepository,
  gate: LockGate,
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

function gateOrderLock(
  inner: TransactionalDineInOrderRepository,
  gate: LockGate,
): TransactionalDineInOrderRepository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "lockById") {
        return async (orderId: string) => {
          const row = await target.lockById(orderId);
          if (row) await gate.onOrderLocked(orderId);
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
    private readonly gate: LockGate,
  ) {}

  async runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      const gated: DineInTransactionRepos = {
        ...repos,
        diningSessions: gateSessionLock(repos.diningSessions, this.gate),
        dineInOrders: gateOrderLock(repos.dineInOrders, this.gate),
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

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackZA" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrackZB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackZC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-adv-${randomUUID().replace(/-/g, "")}`;
  const label = `I5.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i5.1-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I5.1-Item-${randomUUID().slice(0, 8)}`;

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
    // exactly ONE order in starting state PREPARING + one item snapshot ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I5.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
      VALUES (${orderId}, ${sessionId}, ${restaurantId}, ${ownerUserId}, 'PREPARING', ${orderTotal})
    `);
    await setup.execute(sql`
      INSERT INTO dine_in_order_items
        (id, dine_in_order_id, restaurant_id, menu_item_id, name, base_price, quantity, item_subtotal)
      VALUES (${randomUUID()}, ${orderId}, ${restaurantId}, ${menuItemId}, ${itemName}, ${menuPrice}, ${menuQty}, ${itemSubtotal})
    `);
    console.log(
      "FIXTURE OK: user + restaurant + table + menu_item + ACTIVE session + exactly ONE PREPARING order snapshot",
    );

    // ---- two genuinely independent service backends ----
    // portA (gated) -> DineInOrderService.advanceOrder.
    // portB -> DineInOrderService.cancelOrder.
    const catalogRepo = new DrizzleCatalogRepository(drizzle(poolC) as unknown as DrizzleDb);

    const sessionLocked = deferred();
    const orderLocked = deferred();
    const releaseA = deferred();
    const gate: LockGate = {
      onSessionLocked: async () => {
        sessionLocked.resolve();
      },
      onOrderLocked: async () => {
        orderLocked.resolve();
        await releaseA.promise;
      },
    };

    const gatedPort = new GatedDineInTransactionPort(
      new DrizzleDineInTransactionPort(drizzle(poolA) as unknown as DrizzleDb),
      gate,
    );
    const serviceA = new DineInOrderService(gatedPort, catalogRepo);
    const serviceB = new DineInOrderService(
      new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb),
      catalogRepo,
    );

    // ============================================================
    // STEP 1 — advanceOrder acquires session THEN order FOR UPDATE locks, pauses.
    // ============================================================
    const advancePromise = serviceA.advanceOrder({
      order_id: orderId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
      target_status: "READY_TO_SERVE",
    });
    await withTimeout(sessionLocked.promise, 10000, "advanceOrder never acquired the session lock");
    await withTimeout(orderLocked.promise, 10000, "advanceOrder never acquired the order lock");
    const aPid = await backendPid(poolC, "itrackZA");
    const aAct = await backendActivity(poolC, "itrackZA");
    if (!aPid) throw new Error("INDEPENDENCE FAILED: could not identify advanceOrder backend (itrackZA)");
    console.log(
      `[C] advanceOrder holds session + order locks; backend pid=${aPid} state=${aAct.state} (paused inside real tx)`,
    );

    // ============================================================
    // STEP 2 — cancelOrder starts and BLOCKS on the same session row.
    // ============================================================
    const cancelPromise = serviceB.cancelOrder({
      order_id: orderId,
      caller_user_id: ownerUserId,
      correlation_id: correlationId,
    });

    const bAct = await waitUntilBlocked(poolC, "itrackZB", 8000);
    const bPid = await backendPid(poolC, "itrackZB");
    if (!bPid) throw new Error("INDEPENDENCE FAILED: could not identify cancelOrder backend (itrackZB)");
    if (aPid === bPid) throw new Error(`INDEPENDENCE FAILED: same backend pid ${aPid}`);
    console.log(
      `[C] cancelOrder backend blocked: wait_event_type=${bAct.wait_event_type} wait_event=${bAct.wait_event} state=${bAct.state} pid=${bPid}`,
    );

    const bSettled = await isSettled(cancelPromise);
    if (bSettled) {
      throw new Error("CANCEL BLOCKING FAILED: cancelOrder settled while advanceOrder held the locks");
    }
    console.log("CANCEL BLOCKING: cancelOrder pending (not resolved, no error) while advanceOrder holds");

    const locks = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while cancelOrder blocked: ${JSON.stringify(locks)}`);

    const aXid = locks.find((l) => l.pid === aPid && l.locktype === "transactionid" && l.mode === "ExclusiveLock");
    const bXid = locks.find((l) => l.pid === bPid && l.locktype === "transactionid" && l.mode === "ShareLock");
    const bTuple = locks.find((l) => l.pid === bPid && l.locktype === "tuple" && l.mode === "AccessExclusiveLock");
    if (!aXid || !aXid.granted) throw new Error("LOCK ASSERT FAIL: advanceOrder lacks granted transactionid ExclusiveLock");
    if (!bXid || bXid.granted) throw new Error("LOCK ASSERT FAIL: cancelOrder must show NOT-granted transactionid ShareLock");
    if (!bTuple || !bTuple.granted) throw new Error("LOCK ASSERT FAIL: cancelOrder must hold granted tuple AccessExclusiveLock");
    console.log(
      "LOCK ASSERT: advanceOrder transactionid ExclusiveLock granted=true; cancelOrder transactionid ShareLock granted=false + tuple AccessExclusiveLock granted=true",
    );

    // ============================================================
    // STEP 3 — release advanceOrder: PREPARING->READY_TO_SERVE + COMMIT.
    // ============================================================
    releaseA.resolve();
    const aOutcome = await withTimeout(
      advancePromise as Promise<MutationOutcome<AdvanceOrderResult>>,
      10000,
      "advanceOrder did not complete after release",
    );
    if (aOutcome.kind !== "NEW_MUTATION") {
      throw new Error(`advanceOrder unexpected outcome kind: ${aOutcome.kind}`);
    }
    const advanced = aOutcome.value.order;
    console.log(`[A] advanceOrder committed: order status=${advanced.status}`);
    assertEqual(advanced.status, "READY_TO_SERVE", "advanceOrder order status");

    // ============================================================
    // STEP 4 — cancelOrder proceeds after advanceOrder commit and is REJECTED.
    // ============================================================
    let cancelError: AppError | null = null;
    let cancelResult: unknown = null;
    try {
      cancelResult = await withTimeout(
        cancelPromise,
        10000,
        "cancelOrder did not complete after advanceOrder commit",
      );
    } catch (err) {
      cancelError = err instanceof AppError ? err : null;
      if (!cancelError) {
        throw new Error(`cancelOrder rejected with unexpected error type: ${String(err)}`);
      }
    }
    if (cancelError === null) {
      throw new Error(`cancelOrder unexpectedly SUCCEEDED after advance: ${JSON.stringify(cancelResult)}`);
    }
    console.log(
      `[B] cancelOrder rejected post-advance: code=${cancelError.code} status=${cancelError.status}`,
    );
    assertEqual(cancelError.code, "ORDER_NOT_CANCELLABLE", "cancelOrder rejection code (accepted existing contract)");
    assertEqual(cancelError.status, 409, "cancelOrder rejection status");

    // ============================================================
    // STEP 5 — fresh committed reads: final state, no cancellation metadata,
    // no billing/request artifact, session unchanged.
    // ============================================================
    const orderRows = (await poolC.query(
      `SELECT id, status, cancelled_at, cancelled_by FROM dine_in_orders WHERE session_id = $1`,
      [sessionId],
    )).rows as { id: string; status: string; cancelled_at: Date | null; cancelled_by: string | null }[];
    assertEqual(orderRows.length, 1, "dine_in_orders cardinality (exactly 1, no duplicate)");
    assertEqual(orderRows[0]!.id, orderId, "original order remains");
    assertEqual(orderRows[0]!.status, "READY_TO_SERVE", "final order status READY_TO_SERVE");
    assertEqual(orderRows[0]!.cancelled_at, null, "cancelled_at NULL (no cancellation metadata)");
    assertEqual(orderRows[0]!.cancelled_by, null, "cancelled_by NULL (no cancellation metadata)");

    const itemRows = (await poolC.query(
      `SELECT dine_in_order_id, quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = $1`,
      [orderId],
    )).rows as { dine_in_order_id: string; quantity: number; item_subtotal: string }[];
    assertEqual(itemRows.length, 1, "dine_in_order_items cardinality (snapshot unchanged)");
    assertEqual(itemRows[0]!.quantity, menuQty, "order item quantity unchanged");
    assertNum(Number(itemRows[0]!.item_subtotal), itemSubtotal, "order item_subtotal unchanged");

    const sessionRows = (await poolC.query(
      `SELECT status FROM dining_sessions WHERE id = $1`,
      [sessionId],
    )).rows as { status: string }[];
    assertEqual(sessionRows[0]!.status, "ACTIVE", "session unchanged (still ACTIVE)");

    const billRows = (await poolC.query(
      `SELECT count(*)::int AS c FROM session_bills WHERE session_id = $1`,
      [sessionId],
    )).rows as { c: number }[];
    assertEqual(billRows[0]!.c, 0, "session_bills cardinality (0 — no billing artifact)");

    const srRows = (await poolC.query(
      `SELECT count(*)::int AS c FROM service_requests WHERE session_id = $1`,
      [sessionId],
    )).rows as { c: number }[];
    assertEqual(srRows[0]!.c, 0, "service_requests cardinality (0 — no request artifact)");

    const idle = await countIdleInTransaction(poolC);
    console.log(`IDLE-IN-TRANSACTION: ${idle} (expect 0)`);
    if (idle !== 0) throw new Error(`CLEANUP FAILED: ${idle} idle-in-transaction sessions left`);

    console.log("I5.1 ADVANCE-WINS PROOF OK");
  } catch (err) {
    console.error("I5.1 PROOF FAILED:", err instanceof Error ? err.message : err);
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
