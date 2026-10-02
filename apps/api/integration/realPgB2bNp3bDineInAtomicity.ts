// ============================================================
// EVT-B2B-NP3-B — Real PostgreSQL proof that the six scoped Dine-In state
// events are enqueued on the SAME transaction as the authoritative business
// mutation (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with a disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_np3b_run \
//   pnpm exec tsx apps/api/integration/realPgB2bNp3bDineInAtomicity.ts
//
// `evt_np3b_run` is a disposable DB created fresh and fully migrated with
// `pnpm --filter @snakzap/db exec drizzle-kit migrate` (all 28 migrations).
//
// SCOPE NOTE (truthful limitation): this harness drives the REAL
// `DiningSessionService` over the REAL `DrizzleDineInTransactionPort`
// (real tx-scoped repositories + real `DrizzleEventOutboxRepository` on the
// same `tx`). It does NOT mock the emitter: the default
// `enqueueDineInEventFacts` path runs. It seeds fixtures directly with SQL and
// reproduces only the preconditions each command needs. The rollback case uses
// a thin test-only wrapper that discards the callback result and throws INSIDE
// the transaction after the service has enqueued, proving the outbox row is
// truly part of the rolled-back transaction.
//
// Proves, per scoped event, against real PostgreSQL:
//   success mutation -> exactly one durable child row
//   duplicate/retry  -> zero additional child rows
//   rollback         -> zero child rows
//
// Memory mode cannot prove any of this
// (MEMORY_ATOMICITY_GUARANTEE = NONE).
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
import type {
  MutationOutcome,
  OpenSessionResult,
  RequestBillResult,
  CreateServiceRequestResult,
  AcknowledgeServiceRequestResult,
  CompleteServiceRequestResult,
  CancelServiceRequestResult,
  DineInEventFact,
} from "../src/services/dineInSession";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable EVT DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV");
  process.exit(2);
}

const PREFIX = "itrack-np3b-";

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
}

type Exec = (q: unknown) => Promise<unknown>;
const exec = (db: DrizzleDb, q: unknown) =>
  (db as unknown as { execute: Exec }).execute(q);

async function countByCorr(
  db: DrizzleDb,
  eventName: string,
  correlationId: string,
): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox
        WHERE event_name = ${eventName}
          AND metadata->>'correlation_id' = ${correlationId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function countsByCorr(
  db: DrizzleDb,
  correlationId: string,
): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox
        WHERE metadata->>'correlation_id' = ${correlationId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

/** Test-only wrapper: runs the real tx, then throws before commit so the whole
 *  transaction (including any enqueued child rows) rolls back. */
class RollbackAfterPort implements DineInTransactionPort {
  constructor(private readonly inner: DineInTransactionPort) {}

  runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      await fn(repos);
      throw new Error("np3b-force-rollback");
    });
  }
}

interface World {
  userId: string;
  restaurantId: string;
  tableId: string;
  tableToken: string;
}

async function seedWorld(
  db: DrizzleDb,
  created: { users: string[]; restaurants: string[]; tables: string[] },
  tokenPrefix: string,
): Promise<World> {
  const userId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const tableToken = `${tokenPrefix}-${randomUUID().replace(/-/g, "")}`;
  created.users.push(userId);
  created.restaurants.push(restaurantId);
  created.tables.push(tableId);

  await exec(
    db,
    sql`INSERT INTO users (id, phone) VALUES (${userId}, ${`itrack-np3b-${randomUUID()}`})`,
  );
  await exec(
    db,
    sql`INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
        VALUES (${restaurantId}, ${userId}, ${`NP3B-R-${randomUUID().slice(0, 8)}`},
                ${`GST${randomUUID().replace(/-/g, "").slice(0, 12)}`},
                ${`FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`}, true)`,
  );
  await exec(
    db,
    sql`INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
        VALUES (${tableId}, ${restaurantId}, ${`T-${randomUUID().slice(0, 8)}`}, ${tableToken})`,
  );
  return { userId, restaurantId, tableId, tableToken };
}

async function seedSession(
  db: DrizzleDb,
  w: World,
  status: "OPEN" | "ACTIVE" | "CLOSED",
  created: { sessions: string[] },
): Promise<string> {
  const sessionId = randomUUID();
  created.sessions.push(sessionId);
  await exec(
    db,
    sql`INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
        VALUES (${sessionId}, ${w.restaurantId}, ${w.tableId}, ${w.userId}, ${status})`,
  );
  return sessionId;
}

async function seedBillableOrder(
  db: DrizzleDb,
  w: World,
  sessionId: string,
): Promise<void> {
  const menuItemId = randomUUID();
  const orderId = randomUUID();
  await exec(
    db,
    sql`INSERT INTO menu_items (id, restaurant_id, name, price)
        VALUES (${menuItemId}, ${w.restaurantId}, ${`MI-${randomUUID().slice(0, 8)}`}, 199.00)`,
  );
  await exec(
    db,
    sql`INSERT INTO dine_in_orders (id, session_id, restaurant_id, placed_by, status, total_amount)
        VALUES (${orderId}, ${sessionId}, ${w.restaurantId}, ${w.userId}, 'PLACED', 199.00)`,
  );
  await exec(
    db,
    sql`INSERT INTO dine_in_order_items
          (id, dine_in_order_id, restaurant_id, menu_item_id, name, base_price, quantity, item_subtotal)
        VALUES (${randomUUID()}, ${orderId}, ${w.restaurantId}, ${menuItemId},
                ${`MI-${randomUUID().slice(0, 8)}`}, 199.00, 1, 199.00)`,
  );
}

async function seedServiceRequest(
  db: DrizzleDb,
  w: World,
  sessionId: string,
  status: "PENDING" | "ACKNOWLEDGED",
): Promise<string> {
  const requestId = randomUUID();
  const ackBy = status === "ACKNOWLEDGED" ? w.userId : null;
  const ackAt = status === "ACKNOWLEDGED" ? new Date().toISOString() : null;
  await exec(
    db,
    sql`INSERT INTO service_requests
          (id, session_id, restaurant_id, requested_by, request_type, status,
           acknowledged_by, acknowledged_at)
        VALUES (${requestId}, ${sessionId}, ${w.restaurantId}, ${w.userId}, 'WATER',
                ${status}, ${ackBy}, ${ackAt})`,
  );
  return requestId;
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const realPort = new DrizzleDineInTransactionPort(db);
  const rollbackPort = new RollbackAfterPort(new DrizzleDineInTransactionPort(db));
  const service = new DiningSessionService(realPort);
  const rollbackService = new DiningSessionService(rollbackPort);

  const created: {
    users: string[];
    restaurants: string[];
    tables: string[];
    sessions: string[];
  } = { users: [], restaurants: [], tables: [], sessions: [] };

  const corr = (): string => `${PREFIX}${randomUUID()}`;

  try {
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_outbox') IS NOT NULL AS a,
                 to_regclass('dining_sessions') IS NOT NULL AS b,
                 to_regclass('service_requests') IS NOT NULL AS c,
                 to_regclass('session_bills') IS NOT NULL AS d`,
    )) as unknown as {
      rows: { a: boolean; b: boolean; c: boolean; d: boolean }[];
    };
    const r0 = present.rows[0];
    check(
      r0?.a === true && r0?.b === true && r0?.c === true && r0?.d === true,
      "NP3B-PG-0 required tables present",
    );

    // =========================================================
    // SessionOpened — openSession
    // =========================================================
    {
      const w = await seedWorld(db, created, "np3b-so");
      const c1 = corr();
      const out = (await service.openSession({
        caller_user_id: w.userId,
        table_token: w.tableToken,
        correlation_id: c1,
      })) as MutationOutcome<OpenSessionResult, DineInEventFact>;
      check(out.kind === "NEW_MUTATION", "NP3B-PG-SESSION-OPENED success outcome");
      const sessionId = out.kind === "NEW_MUTATION" && out.value.kind === "CREATED"
        ? out.value.session.id
        : "";
      check(sessionId !== "", "NP3B-PG-SESSION-OPENED created session id");
      created.sessions.push(sessionId);
      check(
        (await countByCorr(db, "SessionOpened", c1)) === 1,
        "NP3B-PG-SESSION-OPENED success_exactly_one child row",
      );
      const agg = (await exec(
        db,
        sql`SELECT aggregate_id FROM event_outbox
            WHERE event_name = 'SessionOpened' AND metadata->>'correlation_id' = ${c1}`,
      )) as unknown as { rows: { aggregate_id: string }[] };
      check(
        agg.rows[0]?.aggregate_id === sessionId,
        "NP3B-PG-SESSION-OPENED aggregate is the session id",
      );

      const c1r = corr();
      const resume = (await service.openSession({
        caller_user_id: w.userId,
        table_token: w.tableToken,
        correlation_id: c1r,
      })) as MutationOutcome<OpenSessionResult, DineInEventFact>;
      check(resume.kind === "IDEMPOTENT_NO_MUTATION", "NP3B-PG-SESSION-OPENED resume outcome");
      check(
        (await countsByCorr(db, c1r)) === 0,
        "NP3B-PG-SESSION-OPENED duplicate_zero child rows",
      );

      const wrb = await seedWorld(db, created, "np3b-so-rb");
      const c1rb = corr();
      let threw = false;
      try {
        await rollbackService.openSession({
          caller_user_id: wrb.userId,
          table_token: wrb.tableToken,
          correlation_id: c1rb,
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3B-PG-SESSION-OPENED rollback propagated");
      check(
        (await countsByCorr(db, c1rb)) === 0,
        "NP3B-PG-SESSION-OPENED rollback child rows == 0",
      );
      const sessionRows = (await exec(
        db,
        sql`SELECT count(*)::text AS n FROM dining_sessions WHERE table_id = ${wrb.tableId}`,
      )) as unknown as { rows: { n: string }[] };
      check(
        Number(sessionRows.rows[0]?.n ?? "0") === 0,
        "NP3B-PG-SESSION-OPENED rollback session effect == 0",
      );
    }

    // =========================================================
    // BillRequested + ServiceRequestCreated (BRING_BILL) — requestBill
    // =========================================================
    {
      const w = await seedWorld(db, created, "np3b-br");
      const sessionId = await seedSession(db, w, "ACTIVE", created);
      await seedBillableOrder(db, w, sessionId);
      const c2 = corr();
      const out = (await service.requestBill({
        session_id: sessionId,
        caller_user_id: w.userId,
        correlation_id: c2,
      })) as MutationOutcome<RequestBillResult, DineInEventFact>;
      check(out.kind === "NEW_MUTATION", "NP3B-PG-BILL-REQUESTED success outcome");
      const requestId = out.kind === "NEW_MUTATION" ? out.value.bringBillRequest.id : "";
      check(
        (await countByCorr(db, "BillRequested", c2)) === 1,
        "NP3B-PG-BILL-REQUESTED success_exactly_one child row",
      );
      check(
        (await countByCorr(db, "ServiceRequestCreated", c2)) === 1,
        "NP3B-PG-BRING-BILL-CREATED success_exactly_one child row",
      );
      check((await countsByCorr(db, c2)) === 2, "NP3B-PG-REQUEST-BILL total_children == 2");
      const bills = (await exec(
        db,
        sql`SELECT count(*)::text AS n FROM session_bills WHERE session_id = ${sessionId}`,
      )) as unknown as { rows: { n: string }[] };
      check(Number(bills.rows[0]?.n ?? "0") === 1, "NP3B-PG-BILL-REQUESTED frozen bill committed");
      const sr = (await exec(
        db,
        sql`SELECT aggregate_id FROM event_outbox
            WHERE event_name = 'ServiceRequestCreated' AND metadata->>'correlation_id' = ${c2}`,
      )) as unknown as { rows: { aggregate_id: string }[] };
      check(
        sr.rows[0]?.aggregate_id === requestId,
        "NP3B-PG-BRING-BILL-CREATED aggregate is the request id",
      );

      const c2r = corr();
      const repeat = (await service.requestBill({
        session_id: sessionId,
        caller_user_id: w.userId,
        correlation_id: c2r,
      })) as MutationOutcome<RequestBillResult, DineInEventFact>;
      check(repeat.kind === "IDEMPOTENT_NO_MUTATION", "NP3B-PG-BILL-REQUESTED repeat outcome");
      check(
        (await countsByCorr(db, c2r)) === 0,
        "NP3B-PG-BILL-REQUESTED duplicate_zero child rows",
      );

      const wrb = await seedWorld(db, created, "np3b-br-rb");
      const rbSession = await seedSession(db, wrb, "ACTIVE", created);
      await seedBillableOrder(db, wrb, rbSession);
      const c2rb = corr();
      let threw = false;
      try {
        await rollbackService.requestBill({
          session_id: rbSession,
          caller_user_id: wrb.userId,
          correlation_id: c2rb,
        });
      } catch {
        threw = true;
      }
      check(threw, "NP3B-PG-BILL-REQUESTED rollback propagated");
      check(
        (await countsByCorr(db, c2rb)) === 0,
        "NP3B-PG-BILL-REQUESTED rollback child rows == 0",
      );
      const rbBills = (await exec(
        db,
        sql`SELECT count(*)::text AS n FROM session_bills WHERE session_id = ${rbSession}`,
      )) as unknown as { rows: { n: string }[] };
      check(
        Number(rbBills.rows[0]?.n ?? "0") === 0,
        "NP3B-PG-BILL-REQUESTED rollback frozen bill == 0",
      );
    }

    // =========================================================
    // Generic ServiceRequest lifecycle (CREATED/ACK/COMPLETE/CANCEL)
    // =========================================================
    {
      const w = await seedWorld(db, created, "np3b-sr");
      const sessionId = await seedSession(db, w, "OPEN", created);

      // -- ServiceRequestCreated (generic) --
      const cCreate = corr();
      const createOut = (await service.createServiceRequest({
        session_id: sessionId,
        caller_user_id: w.userId,
        correlation_id: cCreate,
        request_type: "WATER",
      })) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
      check(createOut.kind === "NEW_MUTATION", "NP3B-PG-SR-CREATED success outcome");
      const reqId = createOut.kind === "NEW_MUTATION" ? createOut.value.request.id : "";
      check(
        (await countByCorr(db, "ServiceRequestCreated", cCreate)) === 1,
        "NP3B-PG-SR-CREATED success_exactly_one child row",
      );
      const createAgg = (await exec(
        db,
        sql`SELECT aggregate_id FROM event_outbox
            WHERE event_name = 'ServiceRequestCreated' AND metadata->>'correlation_id' = ${cCreate}`,
      )) as unknown as { rows: { aggregate_id: string }[] };
      check(
        createAgg.rows[0]?.aggregate_id === reqId,
        "NP3B-PG-SR-CREATED aggregate is the request id",
      );

      // -- ServiceRequestAcknowledged --
      const cAck = corr();
      const ackOut = (await service.acknowledgeServiceRequest({
        request_id: reqId,
        caller_user_id: w.userId,
        correlation_id: cAck,
      })) as MutationOutcome<AcknowledgeServiceRequestResult, DineInEventFact>;
      check(ackOut.kind === "NEW_MUTATION", "NP3B-PG-SR-ACK success outcome");
      check(
        (await countByCorr(db, "ServiceRequestAcknowledged", cAck)) === 1,
        "NP3B-PG-SR-ACK success_exactly_one child row",
      );
      const cAckR = corr();
      const ackRepeat = (await service.acknowledgeServiceRequest({
        request_id: reqId,
        caller_user_id: w.userId,
        correlation_id: cAckR,
      })) as MutationOutcome<AcknowledgeServiceRequestResult, DineInEventFact>;
      check(ackRepeat.kind === "IDEMPOTENT_NO_MUTATION", "NP3B-PG-SR-ACK repeat outcome");
      check(
        (await countsByCorr(db, cAckR)) === 0,
        "NP3B-PG-SR-ACK duplicate_zero child rows",
      );

      // -- ServiceRequestCompleted --
      const cComp = corr();
      const compOut = (await service.completeServiceRequest({
        request_id: reqId,
        caller_user_id: w.userId,
        correlation_id: cComp,
      })) as MutationOutcome<CompleteServiceRequestResult, DineInEventFact>;
      check(compOut.kind === "NEW_MUTATION", "NP3B-PG-SR-COMPLETE success outcome");
      check(
        (await countByCorr(db, "ServiceRequestCompleted", cComp)) === 1,
        "NP3B-PG-SR-COMPLETE success_exactly_one child row",
      );
      const cCompR = corr();
      const compRepeat = (await service.completeServiceRequest({
        request_id: reqId,
        caller_user_id: w.userId,
        correlation_id: cCompR,
      })) as MutationOutcome<CompleteServiceRequestResult, DineInEventFact>;
      check(compRepeat.kind === "IDEMPOTENT_NO_MUTATION", "NP3B-PG-SR-COMPLETE repeat outcome");
      check(
        (await countsByCorr(db, cCompR)) === 0,
        "NP3B-PG-SR-COMPLETE duplicate_zero child rows",
      );

      // -- ServiceRequestCancelled --
      const cCreate2 = corr();
      const create2 = (await service.createServiceRequest({
        session_id: sessionId,
        caller_user_id: w.userId,
        correlation_id: cCreate2,
        request_type: "CUTLERY",
      })) as MutationOutcome<CreateServiceRequestResult, DineInEventFact>;
      const req2 = create2.kind === "NEW_MUTATION" ? create2.value.request.id : "";
      const cCan = corr();
      const canOut = (await service.cancelServiceRequest({
        request_id: req2,
        caller_user_id: w.userId,
        correlation_id: cCan,
      })) as MutationOutcome<CancelServiceRequestResult, DineInEventFact>;
      check(canOut.kind === "NEW_MUTATION", "NP3B-PG-SR-CANCEL success outcome");
      check(
        (await countByCorr(db, "ServiceRequestCancelled", cCan)) === 1,
        "NP3B-PG-SR-CANCEL success_exactly_one child row",
      );
      const cCanR = corr();
      const canRepeat = (await service.cancelServiceRequest({
        request_id: req2,
        caller_user_id: w.userId,
        correlation_id: cCanR,
      })) as MutationOutcome<CancelServiceRequestResult, DineInEventFact>;
      check(canRepeat.kind === "IDEMPOTENT_NO_MUTATION", "NP3B-PG-SR-CANCEL repeat outcome");
      check(
        (await countsByCorr(db, cCanR)) === 0,
        "NP3B-PG-SR-CANCEL duplicate_zero child rows",
      );

      // -- rejection paths enqueue nothing --
      const wClosed = await seedWorld(db, created, "np3b-sr-closed");
      const closedSession = await seedSession(db, wClosed, "CLOSED", created);
      const cRej = corr();
      let rejThrew = false;
      try {
        await service.createServiceRequest({
          session_id: closedSession,
          caller_user_id: wClosed.userId,
          correlation_id: cRej,
          request_type: "WATER",
        });
      } catch {
        rejThrew = true;
      }
      check(rejThrew, "NP3B-PG-SR-CREATED closed-session rejection propagated");
      check(
        (await countsByCorr(db, cRej)) === 0,
        "NP3B-PG-SR-CREATED rejection_zero child rows",
      );

      // -- rollback per generic event --
      // CREATED rollback
      {
        const wrb = await seedWorld(db, created, "np3b-sr-cr-rb");
        const s = await seedSession(db, wrb, "OPEN", created);
        const c = corr();
        let threw = false;
        try {
          await rollbackService.createServiceRequest({
            session_id: s,
            caller_user_id: wrb.userId,
            correlation_id: c,
            request_type: "WATER",
          });
        } catch {
          threw = true;
        }
        check(threw, "NP3B-PG-SR-CREATED rollback propagated");
        check((await countsByCorr(db, c)) === 0, "NP3B-PG-SR-CREATED rollback child rows == 0");
        const n = (await exec(
          db,
          sql`SELECT count(*)::text AS n FROM service_requests WHERE session_id = ${s}`,
        )) as unknown as { rows: { n: string }[] };
        check(
          Number(n.rows[0]?.n ?? "0") === 0,
          "NP3B-PG-SR-CREATED rollback request effect == 0",
        );
      }
      // ACK rollback
      {
        const wrb = await seedWorld(db, created, "np3b-sr-ack-rb");
        const s = await seedSession(db, wrb, "OPEN", created);
        const r = await seedServiceRequest(db, wrb, s, "PENDING");
        const c = corr();
        let threw = false;
        try {
          await rollbackService.acknowledgeServiceRequest({
            request_id: r,
            caller_user_id: wrb.userId,
            correlation_id: c,
          });
        } catch {
          threw = true;
        }
        check(threw, "NP3B-PG-SR-ACK rollback propagated");
        check((await countsByCorr(db, c)) === 0, "NP3B-PG-SR-ACK rollback child rows == 0");
        const st = (await exec(
          db,
          sql`SELECT status FROM service_requests WHERE id = ${r}`,
        )) as unknown as { rows: { status: string }[] };
        check(st.rows[0]?.status === "PENDING", "NP3B-PG-SR-ACK rollback status unchanged");
      }
      // COMPLETE rollback
      {
        const wrb = await seedWorld(db, created, "np3b-sr-comp-rb");
        const s = await seedSession(db, wrb, "OPEN", created);
        const r = await seedServiceRequest(db, wrb, s, "ACKNOWLEDGED");
        const c = corr();
        let threw = false;
        try {
          await rollbackService.completeServiceRequest({
            request_id: r,
            caller_user_id: wrb.userId,
            correlation_id: c,
          });
        } catch {
          threw = true;
        }
        check(threw, "NP3B-PG-SR-COMPLETE rollback propagated");
        check((await countsByCorr(db, c)) === 0, "NP3B-PG-SR-COMPLETE rollback child rows == 0");
        const st = (await exec(
          db,
          sql`SELECT status FROM service_requests WHERE id = ${r}`,
        )) as unknown as { rows: { status: string }[] };
        check(
          st.rows[0]?.status === "ACKNOWLEDGED",
          "NP3B-PG-SR-COMPLETE rollback status unchanged",
        );
      }
      // CANCEL rollback
      {
        const wrb = await seedWorld(db, created, "np3b-sr-can-rb");
        const s = await seedSession(db, wrb, "OPEN", created);
        const r = await seedServiceRequest(db, wrb, s, "PENDING");
        const c = corr();
        let threw = false;
        try {
          await rollbackService.cancelServiceRequest({
            request_id: r,
            caller_user_id: wrb.userId,
            correlation_id: c,
          });
        } catch {
          threw = true;
        }
        check(threw, "NP3B-PG-SR-CANCEL rollback propagated");
        check((await countsByCorr(db, c)) === 0, "NP3B-PG-SR-CANCEL rollback child rows == 0");
        const st = (await exec(
          db,
          sql`SELECT status FROM service_requests WHERE id = ${r}`,
        )) as unknown as { rows: { status: string }[] };
        check(st.rows[0]?.status === "PENDING", "NP3B-PG-SR-CANCEL rollback status unchanged");
      }
    }
  } finally {
    // ---- fixture cleanup (FK-safe order) ----
    for (const restaurantId of created.restaurants) {
      await pool.query(
        `DELETE FROM dine_in_order_items WHERE dine_in_order_id IN
           (SELECT id FROM dine_in_orders WHERE restaurant_id = $1)`,
        [restaurantId],
      );
      await pool.query(`DELETE FROM dine_in_orders WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM session_bills WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM service_requests WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM staff_assignments WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM dining_sessions WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM restaurant_tables WHERE restaurant_id = $1`, [restaurantId]);
      await pool.query(`DELETE FROM menu_items WHERE restaurant_id = $1`, [restaurantId]);
    }
    for (const restaurantId of created.restaurants) {
      await pool.query(`DELETE FROM restaurants WHERE id = $1`, [restaurantId]);
    }
    for (const userId of created.users) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await pool.query(
      `DELETE FROM event_outbox WHERE metadata->>'correlation_id' LIKE $1`,
      [`${PREFIX}%`],
    );
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all NP3-B real-PG dine-in atomicity checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
