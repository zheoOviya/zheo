// ============================================================
// I6.1 — Real-PG transaction rollback proof for requestBill
// partial-write atomicity.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillRollback.ts
//
// PROVES (and only claims) the SINGLE partial-write rollback scenario:
//   - A real DiningSessionService.requestBill runs over a real
//     DrizzleDineInTransactionPort + real Drizzle repositories (no memory
//     port/repos).
//   - A TEST-ONLY failure is injected at the repository/transaction boundary
//     AFTER the real SessionBill INSERT has already executed inside the real
//     DB transaction (createFrozenBill returns the real bill; an in-tx
//     getBySessionId re-read confirms the row is visible INSIDE the same
//     transaction) but BEFORE requestBill completes (before the session
//     ACTIVE->BILL_REQUESTED transition, before the BRING_BILL service
//     request, before commit).
//   - requestBill rejects with the injected test error (NOT translated into
//     a domain error).
//   - The outer real-PG transaction rolls back. On a FRESH independent
//     connection: session is still ACTIVE with bill_requested_at NULL,
//     session_bills has 0 rows for the session, service_requests has 0
//     BRING_BILL rows for the session, order/item are unchanged. Zero leak
//     of bill / session-transition / BRING_BILL.
//   - No post-commit event emission occurs (counting emitter: 0 calls).
//
// NO production code is touched; the failure injection lives entirely in
// this harness. No concurrency race, no unique-race testing, no rollback
// injection in production.
//
// DOES NOT claim (I6.2+/I7 territory): every failure point proven,
// cancel/order rollback proven, exhaustive rollback semantics, deadlock-
// free/MVCC generally proven, durable event ordering/outbox/exactly-once.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  SessionBillRepository,
} from "../src/repositories/dineInContracts";
import { makeTxBoundSessionBill } from "../src/repositories/dineInContracts";
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

// ============================================================
// Test-only failure injection at the repository/transaction boundary.
//
// Wraps ONLY the REAL sessionBills.createFrozenBill so that:
//   A. the REAL SessionBill INSERT executes successfully (same real tx)
//   B. an in-tx re-read (getBySessionId) proves the row is visible inside
//      the SAME real transaction (not merely "method was called")
//   C. then the wrapper throws BEFORE requestBill can complete (before the
//      ACTIVE->BILL_REQUESTED session transition, before the BRING_BILL
//      service request, before commit).
//
// The throw happens INSIDE the same real DB transaction callback, so the
// whole outer transaction rolls back. NO production code is modified.
// ============================================================

class RollbackInjectingDineInTransactionPort implements DineInTransactionPort {
  readonly injectedError = new Error(
    "I6.1 test-only injected failure AFTER real SessionBill insert (inside real tx)",
  );
  billInserted = false;
  inTxProof: string | null = null;

  constructor(private readonly inner: DineInTransactionPort) {}

  async runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      const injected: DineInTransactionRepos = {
        ...repos,
        sessionBills: makeTxBoundSessionBill(
          new Proxy(repos.sessionBills as SessionBillRepository, {
            get: (target, prop, receiver) => {
              if (prop === "createFrozenBill") {
                return async (input: Parameters<SessionBillRepository["createFrozenBill"]>[0]) => {
                  // A. real INSERT executes inside the real tx.
                  const bill = await target.createFrozenBill(input);
                  this.billInserted = true;
                  // B. prove the row is visible inside the SAME real tx.
                  const inside = await target.getBySessionId(input.session_id);
                  if (!inside || inside.id !== bill.id) {
                    throw new Error(
                      `I6.1 in-tx proof failed: SessionBill ${bill.id} not visible via getBySessionId(${input.session_id}) inside the transaction`,
                    );
                  }
                  this.inTxProof = inside.id;
                  // C. throw BEFORE requestBill completes; outer tx rolls back.
                  throw this.injectedError;
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      };
      return fn(injected);
    });
  }
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackRA" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackRC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-rb-${randomUUID().replace(/-/g, "")}`;
  const label = `I6.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i6.1-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const itemName = `I6.1-Item-${randomUUID().slice(0, 8)}`;

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

    // ---- minimal real-PG fixture (no domain services): ACTIVE session with
    // exactly one non-CANCELLED billable order + one item snapshot. NO
    // session_bills. NO service_requests. NO BRING_BILL. ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I6.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
    const preBillCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const preReqCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertNum(preBillCount, 0, "session_bills before requestBill (expect 0)");
    assertNum(preReqCount, 0, "service_requests before requestBill (expect 0)");
    console.log(
      "FIXTURE OK: user + restaurant + table + menu_item + ACTIVE session + exactly one non-CANCELLED (PLACED) billable order snapshot; no bill/request artifacts",
    );

    // ---- real service over real port, with the test-only injection wrapper
    // and a counting emitter (asserts no post-commit emission). ----
    const catalogDb = drizzle(poolC) as unknown as DrizzleDb;
    const innerPort = new DrizzleDineInTransactionPort(catalogDb);
    const injectionPort = new RollbackInjectingDineInTransactionPort(innerPort);

    let emitCalls = 0;
    const countingEmitter = async (
      facts: readonly DineInEventFact[],
      _correlationId: string,
    ): Promise<void> => {
      emitCalls += 1;
      console.log(`  EMITTER CALLED (unexpected): ${JSON.stringify(facts)}`);
    };

    const service = new DiningSessionService(injectionPort, countingEmitter);

    // ---- requestBill: must REJECT with the injected test error (not
    // translated into a domain error). ----
    let rejectedError: unknown = null;
    try {
      await service.requestBill({
        session_id: sessionId,
        caller_user_id: ownerUserId,
        correlation_id: correlationId,
      });
    } catch (err) {
      rejectedError = err;
    }
    assertTrue(rejectedError !== null, "requestBill rejected (did not complete)");
    assertTrue(
      rejectedError instanceof Error && rejectedError.message === injectionPort.injectedError.message,
      "rejection is the injected test error (not translated into a domain error)",
    );
    console.log(`  requestBill rejected: ${rejectedError instanceof Error ? rejectedError.message : String(rejectedError)}`);

    // ---- failure was injected AFTER the real insert, inside the real tx ----
    assertTrue(injectionPort.billInserted, "real SessionBill INSERT executed inside the real tx");
    assertTrue(
      injectionPort.inTxProof !== null,
      "in-tx proof: SessionBill row was visible via real getBySessionId inside the SAME transaction",
    );
    console.log(`  IN-TX PROOF: SessionBill ${injectionPort.inTxProof} visible inside the real transaction before throw`);

    // ---- fresh independent connection: decisive rollback evidence ----
    const fresh = drizzle(poolC);
    const sessionRow = (await fresh.execute(
      sql`SELECT status, bill_requested_at FROM dining_sessions WHERE id = ${sessionId}`,
    )).rows[0] as { status: string; bill_requested_at: string | null };
    const billAfter = (await fresh.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const bringBillAfter = (await fresh.execute(
      sql`SELECT count(*)::int AS c FROM service_requests
           WHERE session_id = ${sessionId} AND request_type = 'BRING_BILL'`,
    )).rows[0]?.c as number;
    const reqAllAfter = (await fresh.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    const orderRow = (await fresh.execute(
      sql`SELECT status, total_amount FROM dine_in_orders WHERE id = ${orderId}`,
    )).rows[0] as { status: string; total_amount: string };
    const itemRow = (await fresh.execute(
      sql`SELECT quantity, item_subtotal FROM dine_in_order_items WHERE dine_in_order_id = ${orderId}`,
    )).rows[0] as { quantity: number; item_subtotal: string };

    assertEqual(sessionRow.status, "ACTIVE", "fresh connection: session still ACTIVE (no ACTIVE->BILL_REQUESTED leak)");
    assertEqual(sessionRow.bill_requested_at, null, "fresh connection: bill_requested_at unchanged (NULL)");
    assertNum(billAfter, 0, "fresh connection: 0 session_bills for session (no partial bill leak)");
    assertNum(bringBillAfter, 0, "fresh connection: 0 BRING_BILL service_requests for session (no request leak)");
    assertNum(reqAllAfter, 0, "fresh connection: 0 service_requests for session (nothing leaked)");
    assertEqual(orderRow.status, "PLACED", "fresh connection: order unchanged (PLACED)");
    assertNum(itemRow.quantity, 1, "fresh connection: order item quantity unchanged");
    assertNum(Number(itemRow.item_subtotal), itemSubtotal, "fresh connection: order item_subtotal unchanged");
    console.log("FRESH-CONNECTION ROLLBACK PROOF: session/bill/request/order/item all unchanged — zero partial-state leak");

    // ---- no post-commit event emission ----
    assertNum(emitCalls, 0, "no post-commit event emission (emitter never called)");

    // ---- transaction cleanup: no open tx / idle-in-transaction backends ----
    const idleMid = await countIdleInTransaction(poolC);
    assertNum(idleMid, 0, "idle-in-transaction after rollback (expect 0)");
    console.log(`IDLE-IN-TRANSACTION (after rollback, before cleanup): ${idleMid} (expect 0)`);

    // ---- fixture cleanup (FK-safe order) ----
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

    console.log("I6.1 ROLLBACK PROOF OK");
  } finally {
    await poolA.end();
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
