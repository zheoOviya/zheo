// ============================================================
// I6.2 — Real-PG requestBill LATE-transaction rollback proof.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgRequestBillLateRollback.ts
//
// PROVES (and only claims) the SINGLE late rollback scenario for the
// requestBill artifact set:
//   - A real DiningSessionService.requestBill runs over a real
//     DrizzleDineInTransactionPort + real Drizzle repositories (no memory
//     transaction port).
//   - ALL THREE artifacts execute inside the SAME real DB transaction:
//       A. SessionBill insert (createFrozenBill)
//       B. session ACTIVE -> BILL_REQUESTED transition (bill_requested_at set)
//       C. BRING_BILL ServiceRequest insert
//     The service callback returns its NEW_MUTATION outcome (it believes the
//     work is done), THEN a TEST-ONLY failure is thrown while still inside
//     db.transaction(...) — i.e. AFTER the full artifact set, BEFORE COMMIT.
//   - The in-tx full artifact proof is gathered with the SAME tx-scoped real
//     repositories (session BILL_REQUESTED/bill_requested_at set, exactly 1
//     SessionBill with expected frozen values, exactly 1 BRING_BILL PENDING,
//     order/item snapshot present and unchanged).
//   - requestBill rejects with the injected harness error (NOT converted to
//     a domain error). No post-commit emitter invocation occurs.
//   - The outer transaction rolls back. On a FRESH independent PG connection:
//     session is ACTIVE with bill_requested_at NULL, session_bills 0,
//     BRING_BILL/service_requests 0, order unchanged, item snapshot unchanged.
//   - Artifact ID leak boundary: IDs created inside the aborted tx existed
//     transiently in memory only and must NOT exist in fresh committed state.
//
// NO production code is touched; the late failure lives entirely in this
// harness. No concurrency race, no unique-race testing.
//
// DOES NOT claim (I7+/generic): every failure point exhaustively proven, all
// services' rollback semantics proven, generic MVCC correctness, deadlock-
// free behavior, durable event ordering/outbox/exactly-once.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
} from "../src/repositories/dineInContracts";
import { DrizzleDineInTransactionPort } from "../src/repositories/drizzle/dineInTransactionPort";
import { DiningSessionService } from "../src/services/dineInSession";
import type { MutationOutcome } from "../src/services/dineInSession";
import type { RequestBillResult } from "../src/services/dineInSession";
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

interface InTxArtifactProof {
  sessionStatus: string;
  billRequestedAt: string | null;
  billId: string | null;
  billTotal: number | null;
  bringBillId: string | null;
  bringBillStatus: string | null;
  orderStatus: string | null;
  itemQty: number | null;
  itemSubtotal: number | null;
}

// ============================================================
// Test-only LATE failure injection at the transaction port / callback
// boundary.
//
// The real service callback (fn) runs to completion over the REAL tx-scoped
// repositories — so SessionBill insert, ACTIVE->BILL_REQUESTED transition,
// and BRING_BILL insert ALL execute inside the real db.transaction. The
// wrapper then (1) gathers the in-tx full-artifact proof with the SAME real
// tx repos, and (2) throws the injected error WHILE STILL INSIDE
// db.transaction(...) — i.e. AFTER the full artifact set, BEFORE COMMIT.
// drizzle-orm node-postgres rolls the transaction back on callback rejection.
// NO production code is modified.
// ============================================================

class LateFailureDineInTransactionPort implements DineInTransactionPort {
  readonly injectedError = new Error(
    "I6.2 test-only injected failure AFTER full requestBill artifact set, BEFORE commit",
  );
  serviceOutcomeKind: string | null = null;
  inMemoryBillId: string | null = null;
  inMemoryBringBillId: string | null = null;
  proof: InTxArtifactProof | null = null;

  constructor(private readonly inner: DineInTransactionPort) {}

  async runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      // Full real persistence work executes (all three artifacts), then the
      // service callback resolves with its outcome — the service believes the
      // transaction succeeded.
      const result = await fn(repos);
      const outcome = result as unknown as MutationOutcome<RequestBillResult, DineInEventFact>;
      if (outcome.kind !== "NEW_MUTATION") {
        throw new Error(
          `I6.2 expected NEW_MUTATION from service callback, got ${String(outcome.kind)} — late-failure window missed`,
        );
      }
      this.serviceOutcomeKind = outcome.kind;
      this.inMemoryBillId = outcome.value.bill.id;
      this.inMemoryBringBillId = outcome.value.bringBillRequest?.id ?? null;

      // ---- in-tx full artifact proof (SAME real tx-scoped repos) ----
      const session = await repos.diningSessions.getById(outcome.value.session.id);
      const bill = await repos.sessionBills.getBySessionId(outcome.value.session.id);
      const bring = await repos.serviceRequests.findBringBillBySession(outcome.value.session.id);
      const orders = await repos.dineInOrders.getBySessionWithItems(outcome.value.session.id);

      if (!session) throw new Error("I6.2 in-tx proof failed: session not visible");
      if (!bill) throw new Error("I6.2 in-tx proof failed: SessionBill not visible in tx");
      if (bring.kind !== "FOUND") throw new Error("I6.2 in-tx proof failed: BRING_BILL not FOUND in tx");
      if (orders.length !== 1) throw new Error(`I6.2 in-tx proof failed: expected 1 order, got ${orders.length}`);
      const order = orders[0]!;
      if (order.items.length !== 1) {
        throw new Error(`I6.2 in-tx proof failed: expected 1 item, got ${order.items.length}`);
      }
      this.proof = {
        sessionStatus: session.status,
        billRequestedAt: session.bill_requested_at,
        billId: bill.id,
        billTotal: bill.total_amount,
        bringBillId: bring.value.id,
        bringBillStatus: bring.value.status,
        orderStatus: order.status,
        itemQty: order.items[0]!.quantity,
        itemSubtotal: order.items[0]!.item_subtotal,
      };

      // ---- LATE pre-commit failure: throw while still inside db.transaction,
      // AFTER the full artifact set. Outer transaction rolls back. ----
      throw this.injectedError;
    });
  }
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrackSB" });
  const poolC = new Pool({ connectionString: url, application_name: "itrackSC" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  const tableToken = `itrack-lrb-${randomUUID().replace(/-/g, "")}`;
  const label = `I6.2-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const correlationId = `i6.2-${randomUUID()}`;

  const menuPrice = 199.0;
  const menuQty = 1;
  const itemSubtotal = round2(menuPrice * menuQty);
  const orderTotal = round2(itemSubtotal + round2(itemSubtotal * 0.05));
  const billFoodSubtotal = itemSubtotal;
  const billGstFood = round2(itemSubtotal * 0.05);
  const billTotal = round2(itemSubtotal + billGstFood);
  const itemName = `I6.2-Item-${randomUUID().slice(0, 8)}`;

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
      VALUES (${restaurantId}, ${ownerUserId}, ${`I6.2-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
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
    const preSession = (await setup.execute(
      sql`SELECT status, bill_requested_at FROM dining_sessions WHERE id = ${sessionId}`,
    )).rows[0] as { status: string; bill_requested_at: string | null };
    assertNum(preBillCount, 0, "precondition: 0 session_bills for session");
    assertNum(preReqCount, 0, "precondition: 0 service_requests for session");
    assertEqual(preSession.status, "ACTIVE", "precondition: session ACTIVE");
    assertEqual(preSession.bill_requested_at, null, "precondition: bill_requested_at NULL");
    console.log(
      "FIXTURE OK: owner + restaurant/table + ACTIVE session + exactly one non-CANCELLED (PLACED) billable order + one item snapshot; 0 bill / 0 BRING_BILL",
    );

    // ---- real service over real port, with the test-only LATE failure
    // wrapper and a counting emitter (asserts no post-commit emission). ----
    const catalogDb = drizzle(poolC) as unknown as DrizzleDb;
    const innerPort = new DrizzleDineInTransactionPort(catalogDb);
    const latePort = new LateFailureDineInTransactionPort(innerPort);

    let emitCalls = 0;
    const countingEmitter = async (
      facts: readonly DineInEventFact[],
      _correlationId: string,
    ): Promise<void> => {
      emitCalls += 1;
      console.log(`  EMITTER CALLED (unexpected): ${JSON.stringify(facts)}`);
    };

    const service = new DiningSessionService(latePort, countingEmitter);

    // ---- requestBill: the full artifact set executes in-tx, then the
    // injected error fires pre-commit; requestBill must REJECT with the
    // injected harness error (not converted into a domain error). ----
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
    assertTrue(rejectedError !== null, "requestBill rejected (did not complete/commit)");
    assertTrue(
      rejectedError instanceof Error && rejectedError.message === latePort.injectedError.message,
      "rejection is the injected harness error (not converted into a domain error)",
    );
    console.log(`  requestBill rejected: ${rejectedError instanceof Error ? rejectedError.message : String(rejectedError)}`);

    // ---- the service callback fully succeeded in-tx (NEW_MUTATION), i.e.
    // the late-failure window was genuinely AFTER the full artifact set ----
    assertEqual(latePort.serviceOutcomeKind, "NEW_MUTATION", "service callback completed as NEW_MUTATION before the pre-commit throw");

    // ---- in-tx full artifact proof ----
    const p = latePort.proof;
    assertTrue(p !== null, "in-tx full artifact proof gathered");
    assertEqual(p!.sessionStatus, "BILL_REQUESTED", "in-tx proof: session ACTIVE->BILL_REQUESTED visible");
    assertTrue(p!.billRequestedAt !== null, "in-tx proof: bill_requested_at set");
    assertEqual(p!.billId, latePort.inMemoryBillId, "in-tx proof: SessionBill id matches service outcome (exactly 1)");
    assertNum(p!.billTotal ?? -1, billTotal, "in-tx proof: SessionBill total_amount frozen value");
    assertEqual(p!.bringBillId, latePort.inMemoryBringBillId, "in-tx proof: BRING_BILL id matches service outcome (exactly 1)");
    assertEqual(p!.bringBillStatus, "PENDING", "in-tx proof: BRING_BILL status PENDING");
    assertEqual(p!.orderStatus, "PLACED", "in-tx proof: order present and unchanged (PLACED)");
    assertNum(p!.itemQty ?? -1, 1, "in-tx proof: item snapshot qty 1");
    assertNum(p!.itemSubtotal ?? -1, itemSubtotal, "in-tx proof: item snapshot subtotal 199");
    console.log("IN-TRANSACTION FULL ARTIFACT PROOF: bill + BILL_REQUESTED + BRING_BILL all visible via real tx repos before the pre-commit throw");

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

    assertEqual(sessionRow.status, "ACTIVE", "fresh connection: session back to ACTIVE (no BILL_REQUESTED leak)");
    assertEqual(sessionRow.bill_requested_at, null, "fresh connection: bill_requested_at NULL (transition timestamp rolled back)");
    assertNum(billAfter, 0, "fresh connection: 0 session_bills (bill insert rolled back)");
    assertNum(bringBillAfter, 0, "fresh connection: 0 BRING_BILL (request insert rolled back)");
    assertNum(reqAllAfter, 0, "fresh connection: 0 service_requests total");
    assertEqual(orderRow.status, "PLACED", "fresh connection: order unchanged (PLACED)");
    assertNum(itemRow.quantity, 1, "fresh connection: item quantity unchanged");
    assertNum(Number(itemRow.item_subtotal), itemSubtotal, "fresh connection: item_subtotal unchanged");
    console.log("FRESH-CONNECTION ROLLBACK PROOF: all three artifacts absent; session ACTIVE / bill_requested_at NULL; order+item unchanged");

    // ---- artifact ID leak boundary ----
    const leakedBillId = (await fresh.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE id = ${latePort.inMemoryBillId ?? ""}`,
    )).rows[0]?.c as number;
    const leakedBringId = (await fresh.execute(
      sql`SELECT count(*)::int AS c FROM service_requests WHERE id = ${latePort.inMemoryBringBillId ?? ""}`,
    )).rows[0]?.c as number;
    assertNum(leakedBillId, 0, "artifact ID leak boundary: in-memory bill id absent in committed state");
    assertNum(leakedBringId, 0, "artifact ID leak boundary: in-memory BRING_BILL id absent in committed state");
    console.log("ARTIFACT ID LEAK BOUNDARY: IDs created inside the aborted tx existed transiently in memory only; both absent from fresh committed DB state");

    // ---- no post-commit event emission ----
    assertNum(emitCalls, 0, "no post-commit event emission (emitter never called)");

    // ---- transaction cleanup ----
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

    console.log("I6.2 LATE-ROLLBACK PROOF OK");
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
