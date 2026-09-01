// ============================================================
// I7.2-C — requestBill FIRST-WRITER LOCK PROOF (no business completion).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillFirstWriterLock.ts
//
// PROVES (and only claims) the FIRST-WRITER session-lock serialization for a
// concurrent requestBill pair:
//   - requestBill A acquires the REAL dining_sessions FOR UPDATE row lock
//     first (lockById at dineInSession.ts:381) and is paused while HOLDING it.
//   - requestBill B, started for the SAME session, BLOCKS on the SAME session
//     row (pg_stat_activity wait_event_type=Lock / wait_event=transactionid;
//     pg_locks: A holds transactionid ExclusiveLock granted=true, B holds
//     transactionid ShareLock granted=false + tuple AccessExclusiveLock
//     granted=true). B's promise is unresolved and has no error.
//   - A and B run on genuinely independent real PG backends with distinct
//     pg_backend_pid.
//   - BOTH transactions are then safely ABORTED (test-only injected error via
//     the harness gate), so NO business artifact is created and NO
//     bill/cardinality/idempotency claim is made from this checkpoint.
//   - Final committed state: session ACTIVE / bill_requested_at NULL /
//     0 SessionBill / 0 BRING_BILL.
//
// Deterministic control (no arbitrary sleep-based race control): a harness-only
// gate around the REAL diningSessions.lockById fires deferred signals after the
// real FOR UPDATE returns and pauses. NO production code is modified.
//
// DOES NOT claim: exactly-one bill/BRING_BILL result, second-requestBill
// idempotency, or any business outcome. That is I7.2-D territory.
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
import { DiningSessionService } from "../src/services/dineInSession";
import type { DineInEventFact } from "../src/services/dineInSession";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Has the promise settled (resolved or rejected)? */
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

async function countIdleInTransaction(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  )).rows as { c: number }[];
  return rows[0]?.c ?? -1;
}

interface ActivityRow {
  wait_event_type: string | null;
  wait_event: string | null;
  state: string | null;
  pid: number;
}

async function backendActivity(pool: Pool, appName: string): Promise<ActivityRow> {
  const rows = (await pool.query(
    `SELECT pid, wait_event_type, wait_event, state
       FROM pg_stat_activity
      WHERE application_name = $1 AND datname = current_database()`,
    [appName],
  )).rows as ActivityRow[];
  return rows[0] ?? { pid: -1, wait_event_type: null, wait_event: null, state: null };
}

async function waitUntilBlocked(
  pool: Pool,
  appName: string,
  timeoutMs: number,
): Promise<ActivityRow> {
  const deadline = Date.now() + timeoutMs;
  let last: ActivityRow = { pid: -1, wait_event_type: null, wait_event: null, state: null };
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

// ============================================================
// Test-only gate around the REAL diningSessions.lockById (session FOR UPDATE).
// The gate fires a signal after the real lock returns, then pauses. It can be
// released to (a) continue normally or (b) abort — when aborted it throws an
// injected harness error so the transaction rolls back. NO production code is
// modified.
// ============================================================

interface SessionLockGate {
  onSessionLocked: (sessionId: string) => Promise<void>;
}

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

class GatedSessionLockTransactionPort implements DineInTransactionPort {
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

// Gate controller: signal once the real lock is held, pause, then either
// proceed (resume) or abort (throw injected error -> rollback).
function makeGate(): {
  gate: SessionLockGate;
  locked: Promise<void>;
  pause: () => Promise<"proceed" | "abort">;
  proceed: () => void;
  abort: (error: Error) => void;
} {
  let resolveLocked!: () => void;
  const locked = new Promise<void>((r) => {
    resolveLocked = r;
  });
  let decide!: (mode: "proceed" | "abort") => void;
  const pause = new Promise<"proceed" | "abort">((r) => {
    decide = r;
  });
  const gate: SessionLockGate = {
    onSessionLocked: async () => {
      resolveLocked();
      const mode = await pause;
      if (mode === "abort") {
        throw new Error("I7.2-C harness abort (transaction rollback)");
      }
    },
  };
  return {
    gate,
    locked,
    pause: () => pause,
    proceed: () => decide("proceed"),
    abort: (_error: Error) => decide("abort"),
  };
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrack9A" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrack9B" });
  const poolC = new Pool({ connectionString: url, application_name: "itrack9C" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-fw-${randomUUID().replace(/-/g, "")}`;
  const label = `I7.2C-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationA = `i7.2-C-A-${randomUUID()}`;
  const correlationB = `i7.2-C-B-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I7.2C-Item-${randomUUID().slice(0, 8)}`;

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

    // ---- deterministic valid ACTIVE session fixture ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I7.2C-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
    console.log("FIXTURE OK: owner + ACTIVE session + exactly 1 billable order + 1 item; 0 bill/request artifacts");

    // ---- two independent backends with harness-only lock gates ----
    const gateA = makeGate();
    const gateB = makeGate();
    const portA = new GatedSessionLockTransactionPort(
      new DrizzleDineInTransactionPort(drizzle(poolA) as unknown as DrizzleDb),
      gateA.gate,
    );
    const portB = new GatedSessionLockTransactionPort(
      new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb),
      gateB.gate,
    );
    const serviceA = new DiningSessionService(portA, async () => {});
    const serviceB = new DiningSessionService(portB, async () => {});

    // ---- sequence: A starts, acquires real session lock, pauses ----
    const promiseA = serviceA.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationA,
    });
    await gateA.locked;
    const actA = await backendActivity(poolC, "itrack9A");
    assertEqual(actA.state, "idle in transaction", "A holds the session FOR UPDATE lock (paused inside real tx, not blocked)");
    assertTrue(actA.wait_event_type !== "Lock", "A not blocked on any lock");
    console.log(`[A] requestBill A acquired the real session FOR UPDATE lock; paused holding it (pid=${actA.pid})`);

    // ---- B starts, must block on the SAME session row ----
    const promiseB = serviceB.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationB,
    });
    const blockedB = await waitUntilBlocked(poolC, "itrack9B", 8000);
    assertEqual(blockedB.wait_event_type, "Lock", "B backend blocked on a row lock");
    assertEqual(blockedB.wait_event, "transactionid", "B waits on the FIRST transaction's session row lock (lockById FOR UPDATE)");
    console.log(`[B] requestBill B backend blocked: wait_event_type=${blockedB.wait_event_type} wait_event=${blockedB.wait_event} state=${blockedB.state} pid=${blockedB.pid}`);

    // ---- physical blocking proof ----
    assertTrue(actA.pid !== blockedB.pid, `A/B pids distinct (A=${actA.pid}, B=${blockedB.pid})`);
    const bSettled = await isSettled(promiseB);
    assertTrue(!bSettled, "B promise unresolved (no resolution, no error) while A holds the lock");
    const locks = await observeLocks(poolC, actA.pid, blockedB.pid);
    const aTx = locks.find((l) => l.pid === actA.pid && l.locktype === "transactionid" && l.granted);
    const bTx = locks.find((l) => l.pid === blockedB.pid && l.locktype === "transactionid");
    const bTuple = locks.find((l) => l.pid === blockedB.pid && l.locktype === "tuple");
    assertTrue(!!aTx && aTx!.mode === "ExclusiveLock", "pg_locks: A holds transactionid ExclusiveLock granted=true");
    assertTrue(!!bTx && bTx!.mode === "ShareLock" && !bTx!.granted, "pg_locks: B waits transactionid ShareLock granted=false");
    assertTrue(!!bTuple && bTuple!.granted, "pg_locks: B holds tuple AccessExclusiveLock (speculative wait) granted=true");
    console.log(`  pg_locks evidence: A transactionid ExclusiveLock granted=true; B transactionid ShareLock granted=false + tuple granted=true (pid ${blockedB.pid})`);

    // ---- STOP before business completion: abort BOTH transactions safely ----
    // A still holds the lock; abort A first. A's requestBill rejects with the
    // injected harness error (rollback). B then unblocks on the released row.
    gateA.abort(new Error("abort"));
    let aRejected = false;
    try {
      await promiseA;
    } catch {
      aRejected = true;
    }
    assertTrue(aRejected, "A aborted (rollback) — requestBill A rejected with harness error");
    console.log("[A] A aborted (rollback): requestBill A rejected; no bill/transition/BRING_BILL committed");

    // B now acquires the session lock; its gate pauses it before any business
    // write. Prove B moved out of the lock wait, then abort B too.
    await gateB.locked;
    const actB = await backendActivity(poolC, "itrack9B");
    assertEqual(actB.state, "idle in transaction", "B acquired the session lock after A aborted (paused inside real tx, not blocked)");
    assertTrue(actB.wait_event_type !== "Lock", "B not blocked on any lock at pause point");
    console.log(`[B] B acquired the session FOR UPDATE lock after A's rollback; paused before any business write (pid=${actB.pid})`);
    const bStillUnsettled = await isSettled(promiseB);
    assertTrue(!bStillUnsettled, "B still unresolved at pause point (no business completion yet)");

    gateB.abort(new Error("abort"));
    let bRejected = false;
    try {
      await promiseB;
    } catch {
      bRejected = true;
    }
    assertTrue(bRejected, "B aborted (rollback) — requestBill B rejected with harness error");
    console.log("[B] B aborted (rollback): requestBill B rejected; no bill/transition/BRING_BILL committed");

    // ---- NO business outcome: committed state unchanged ----
    const sessionRow = (await setup.execute(
      sql`SELECT status, bill_requested_at FROM dining_sessions WHERE id = ${sessionId}`,
    )).rows[0] as { status: string; bill_requested_at: string | null };
    const billCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const bringCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertEqual(sessionRow.status, "ACTIVE", "no business outcome: session still ACTIVE");
    assertEqual(sessionRow.bill_requested_at, null, "no business outcome: bill_requested_at NULL");
    assertNum(billCount, 0, "no business outcome: 0 SessionBill");
    assertNum(bringCount, 0, "no business outcome: 0 BRING_BILL");
    console.log("STOP BEFORE BUSINESS COMPLETION: both transactions aborted; 0 bill / 0 BRING_BILL / session ACTIVE / bill_requested_at NULL. NO exactly-one or idempotency claim made.");

    // ---- cleanup ----
    await setup.execute(sql`DELETE FROM dine_in_order_items WHERE dine_in_order_id = ${orderId}`);
    await setup.execute(sql`DELETE FROM dine_in_orders WHERE id = ${orderId}`);
    await setup.execute(sql`DELETE FROM dining_sessions WHERE id = ${sessionId}`);
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE id = ${tableId}`);
    await setup.execute(sql`DELETE FROM menu_items WHERE id = ${menuItemId}`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id = ${restaurantId}`);
    await setup.execute(sql`DELETE FROM users WHERE id = ${ownerUserId}`);
    console.log("FIXTURE CLEANUP OK");

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

    console.log("I7.2-C FIRST-WRITER LOCK PROOF OK");
  } finally {
    // Best-effort, non-blocking close. Do NOT await: if an assertion failed
    // mid-flight a transaction may still be paused holding a pool client, and
    // awaiting pool.end() would hang and mask the real error. process.exit()
    // terminates the process and closes the sockets regardless.
    for (const p of [poolA, poolB, poolC]) {
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
