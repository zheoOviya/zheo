// ============================================================
// I7.2-D — FIRST bill commit + SECOND caller idempotent resume.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillIdempotentResume.ts
//
// PROVES (and only claims) the service-level artifact-identity reuse for a
// concurrent requestBill pair on the SAME ACTIVE session:
//   - requestBill A acquires the REAL dining_sessions FOR UPDATE lock first,
//     pauses, then completes a NORMAL requestBill and COMMITs:
//     NEW_MUTATION, session BILL_REQUESTED, exactly 1 SessionBill, exactly 1
//     BRING_BILL. A's bill id + BRING_BILL id are captured.
//   - requestBill B, started while A is paused, physically BLOCKS on the same
//     session row (pg_stat_activity Lock/transactionid; B unresolved/no
//     error). After A commits, B resumes, re-reads the committed
//     BILL_REQUESTED session, and takes the accepted REPEAT path
//     (IDEMPOTENT_NO_MUTATION) — it returns the EXISTING SessionBill and the
//     EXISTING BRING_BILL, with NO recalculation / NO new insert.
//   - Artifact identity: B's bill id == A's bill id; B's BRING_BILL id == A's
//     BRING_BILL id (exposed by the current RequestBillResult DTO).
//   - Final cardinality (fresh read): SessionBill = 1, BRING_BILL = 1,
//     session = BILL_REQUESTED, order/item unchanged.
//   - Event boundary: only observed emitter behavior is recorded (A emits its
//     post-commit facts; B emits nothing). No durable/outbox/exactly-once
//     claim.
//
// Deterministic control (no arbitrary race sleeps): harness-only gate around
// the REAL diningSessions.lockById. NO production code modified.
//
// DOES NOT claim: direct DB duplicate backstop (I7.2-E), exactly-once
// delivery, durable ordering.
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
import type { MutationOutcome, RequestBillResult } from "../src/services/dineInSession";
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

// ============================================================
// Test-only gate around the REAL diningSessions.lockById (session FOR UPDATE).
// Signals after the real lock returns, pauses, then either proceeds (continue)
// or aborts (throw -> rollback). NO production code modified.
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

function makeGate(): {
  gate: SessionLockGate;
  locked: Promise<void>;
  proceed: () => void;
  abort: () => void;
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
        throw new Error("I7.2-D harness abort (transaction rollback)");
      }
    },
  };
  return {
    gate,
    locked,
    proceed: () => decide("proceed"),
    abort: () => decide("abort"),
  };
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackDA" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrackDB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackDC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-ir-${randomUUID().replace(/-/g, "")}`;
  const label = `I7.2D-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationA = `i7.2-D-A-${randomUUID()}`;
  const correlationB = `i7.2-D-B-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const billTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I7.2D-Item-${randomUUID().slice(0, 8)}`;

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
      VALUES (${restaurantId}, ${ownerUserId}, ${`I7.2D-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
    const preBill = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const preBring = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertNum(preBill, 0, "precondition: 0 SessionBill");
    assertNum(preBring, 0, "precondition: 0 BRING_BILL / service_requests");
    console.log("FIXTURE OK: ACTIVE session + 1 billable order + 1 item; 0 bill / 0 BRING_BILL");

    // ---- two independent backends with harness-only lock gates + counting
    // emitters (record observed emitter behavior only) ----
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
    let emitA: Array<readonly DineInEventFact[]> = [];
    let emitB: Array<readonly DineInEventFact[]> = [];
    const serviceA = new DiningSessionService(portA, async (facts) => {
      emitA.push(facts);
    });
    const serviceB = new DiningSessionService(portB, async (facts) => {
      emitB.push(facts);
    });

    // ---- deterministic first-writer sequence ----
    const promiseA = serviceA.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationA,
    });
    await gateA.locked;
    const actA = await backendActivity(poolC, "itrackDA");
    assertEqual(actA.state, "idle in transaction", "A holds the session FOR UPDATE lock (paused)");
    console.log(`[A] requestBill A holds the real session lock (pid=${actA.pid}); paused`);

    const promiseB = serviceB.requestBill({
      session_id: sessionId,
      caller_user_id: ownerUserId,
      correlation_id: correlationB,
    });
    const blockedB = await waitUntilBlocked(poolC, "itrackDB", 8000);
    assertEqual(blockedB.wait_event_type, "Lock", "B backend blocked on a row lock");
    assertEqual(blockedB.wait_event, "transactionid", "B waits on the FIRST transaction's session row lock");
    assertTrue(actA.pid !== blockedB.pid, `A/B pids distinct (A=${actA.pid}, B=${blockedB.pid})`);
    const bSettled = await isSettled(promiseB);
    assertTrue(!bSettled, "B promise unresolved (no resolution, no error) while A holds the lock");
    console.log(`[B] requestBill B physically blocked: wait_event_type=${blockedB.wait_event_type} wait_event=${blockedB.wait_event} state=${blockedB.state} pid=${blockedB.pid}`);

    // ---- release A: A completes a NORMAL requestBill and COMMITs ----
    gateA.proceed();
    const outcomeA = await promiseA;
    assertEqual(outcomeA.kind, "NEW_MUTATION", "A returned the accepted first-freeze discriminator NEW_MUTATION");
    if (outcomeA.kind !== "NEW_MUTATION") throw new Error("I7.2-D: A did not NEW_MUTATION");
    const aBillId = outcomeA.value.bill.id;
    const aBringId = outcomeA.value.bringBillRequest!.id;
    assertEqual(outcomeA.value.session.status, "BILL_REQUESTED", "A's committed session status BILL_REQUESTED");
    console.log(`[A] requestBill A committed: NEW_MUTATION; session BILL_REQUESTED; bill id=${aBillId}; BRING_BILL id=${aBringId}`);

    // ---- B resumes after A's commit, re-reads committed BILL_REQUESTED ----
    await gateB.locked;
    const actB = await backendActivity(poolC, "itrackDB");
    assertEqual(actB.state, "idle in transaction", "B acquired the session lock after A committed (paused before switch)");
    assertTrue(actB.wait_event_type !== "Lock", "B not blocked at its pause point");
    console.log(`[B] requestBill B acquired the lock after A's commit; paused before the state switch (pid=${actB.pid})`);
    gateB.proceed();
    const outcomeB = await promiseB;

    assertEqual(outcomeB.kind, "IDEMPOTENT_NO_MUTATION", "B returned the accepted repeat discriminator IDEMPOTENT_NO_MUTATION (BILL_REQUESTED repeat)");
    if (outcomeB.kind !== "IDEMPOTENT_NO_MUTATION") throw new Error("I7.2-D: B did not IDEMPOTENT_NO_MUTATION");
    const bBillId = outcomeB.value.bill.id;
    const bBringId = outcomeB.value.bringBillRequest!.id;
    console.log(`[B] requestBill B resumed: IDEMPOTENT_NO_MUTATION; existing bill id=${bBillId}; existing BRING_BILL id=${bBringId}; NO recalculation / NO new insert`);

    // ---- artifact identity: B reuses A's exact committed artifact IDs ----
    assertEqual(bBillId, aBillId, "artifact identity: B bill id == A bill id");
    assertEqual(bBringId, aBringId, "artifact identity: B BRING_BILL id == A BRING_BILL id");

    // ---- final cardinality (fresh independent read) ----
    const billCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const bringCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests
           WHERE session_id = ${sessionId} AND request_type = 'BRING_BILL'`,
    )).rows[0]?.c as number;
    const sessionRow = (await setup.execute(
      sql`SELECT status FROM dining_sessions WHERE id = ${sessionId}`,
    )).rows[0] as { status: string };
    const orderRow = (await setup.execute(
      sql`SELECT status, total_amount FROM dine_in_orders WHERE id = ${orderId}`,
    )).rows[0] as { status: string; total_amount: string };
    const itemRow = (await setup.execute(
      sql`SELECT quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = ${orderId}`,
    )).rows[0] as { quantity: number; item_subtotal: string };
    assertNum(billCount, 1, "final cardinality: exactly 1 SessionBill");
    assertNum(bringCount, 1, "final cardinality: exactly 1 BRING_BILL");
    assertEqual(sessionRow.status, "BILL_REQUESTED", "final cardinality: session BILL_REQUESTED");
    assertEqual(orderRow.status, "PLACED", "final cardinality: order unchanged (PLACED)");
    assertNum(itemRow.quantity, 1, "final cardinality: item qty unchanged");
    assertNum(Number(itemRow.item_subtotal), itemSubtotal, "final cardinality: item_subtotal unchanged");
    console.log("FINAL CARDINALITY: 1 SessionBill / 1 BRING_BILL / BILL_REQUESTED / order+item unchanged — no duplicate artifact");

    // ---- event boundary: record observed emitter behavior only ----
    assertNum(emitA.length, 1, "observed emitter: A emitted once (post-commit NEW_MUTATION)");
    assertNum(emitA[0]?.length ?? -1, 2, "observed emitter: A's single emission carries the 2 accepted facts (BILL_REQUESTED + SERVICE_REQUEST_CREATED)");
    assertNum(emitB.length, 0, "observed emitter: B emitted nothing (IDEMPOTENT_NO_MUTATION repeat emits no facts)");
    console.log("EVENT BOUNDARY: A emitted 2 facts post-commit; B emitted 0. No durable/outbox/exactly-once claim.");

    // ---- cleanup ----
    await setup.execute(sql`DELETE FROM service_requests WHERE session_id = ${sessionId}`);
    await setup.execute(sql`DELETE FROM session_bills WHERE session_id = ${sessionId}`);
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

    console.log("I7.2-D FIRST COMMIT + IDEMPOTENT RESUME PROOF OK");
  } finally {
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
