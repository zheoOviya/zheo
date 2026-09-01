// ============================================================
// I7.1 — Real-PG live-session UNIQUE RACE proof.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgLiveSessionUniqueRace.ts
//
// PROVES (and only claims) ONE invariant on real PostgreSQL:
//   concurrent openSession attempts for the SAME restaurant table cannot
//   commit two live DiningSessions.
//
// What is proven, honestly:
//   - Physical precondition: dining_sessions_live_table_idx is UNIQUE, on
//     table_id, PARTIAL for the live statuses OPEN/ACTIVE/BILL_REQUESTED/
//     PAYMENT_PENDING (verified from pg_index, not just migration text).
//   - Two independent PG backends (dedicated pools/ports per service, distinct
//     users A/B so same-owner resume semantics cannot mask the race) race
//     openSession for the SAME table token.
//   - Mechanism: openSession FIRST takes the real restaurant_tables row FOR
//     UPDATE lock (lockByToken). The second backend WAITS on that table row
//     lock (pg_stat_activity wait_event_type=Lock / wait_event=transactionid)
//     until the first commits, then re-reads occupancy and throws the accepted
//     static conflict TABLE_OCCUPIED (409). So the accepted service flow is
//     LOCK-SERIALIZED; the live-session UNIQUE index is a DB backstop, not
//     the race arbiter.
//   - Committed live cardinality for the table is exactly 1 (owner A, OPEN).
//   - Direct DB backstop proof (separate transaction, no service logic): a
//     SECOND live row for the same table is rejected by the physical partial
//     unique index (23505 unique_violation on dining_sessions_live_table_idx).
//   - Partial-index status boundary: one CLOSED historical session may coexist
//     alongside the live session (CLOSED excluded from the partial predicate).
//
// DOES NOT claim (I7.2+/generic): SessionBill uniqueness, BRING_BILL duplicate
// prevention, all unique races safe, deadlock-free, generic MVCC correctness.
//
// NO production code is touched; the gate lives entirely in this harness.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  TransactionalRestaurantTableRepository,
} from "../src/repositories/dineInContracts";
import { DrizzleDineInTransactionPort } from "../src/repositories/drizzle/dineInTransactionPort";
import { DiningSessionService } from "../src/services/dineInSession";
import type { MutationOutcome } from "../src/services/dineInSession";
import type { OpenSessionResult } from "../src/services/dineInSession";
import type { DineInEventFact } from "../src/services/dineInSession";
import { AppError } from "../src/middleware/envelope";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ============================================================
// Test-only gate inserted AFTER the real restaurant_tables row lock
// (lockByToken). NO production code is modified; the real service + real
// repos run intact. Used ONLY on the FIRST backend so we can observe the
// SECOND backend physically waiting on the table row lock.
// ============================================================

function gateTableLock(
  inner: TransactionalRestaurantTableRepository,
  onTableLocked: (tableId: string) => Promise<void>,
): TransactionalRestaurantTableRepository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "lockByToken") {
        return async (tableToken: string) => {
          const row = await target.lockByToken(tableToken);
          if (row) await onTableLocked(row.id);
          return row;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class GatedTableLockTransactionPort implements DineInTransactionPort {
  constructor(
    private readonly inner: DineInTransactionPort,
    private readonly onTableLocked: (tableId: string) => Promise<void>,
  ) {}

  async runInTransaction<T>(fn: (repos: DineInTransactionRepos) => Promise<T>): Promise<T> {
    return this.inner.runInTransaction(async (repos) => {
      const gated: DineInTransactionRepos = {
        ...repos,
        restaurantTables: gateTableLock(repos.restaurantTables, this.onTableLocked),
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

  const poolA = new Pool({ connectionString: url, max: 1, application_name: "itrack7A" });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: "itrack7B" });
  const poolC = new Pool({ connectionString: url, application_name: "itrack7C" });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const tableToken = `itrack-race-${randomUUID().replace(/-/g, "")}`;
  const label = `I7.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;

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

    // ---- physical index precondition (pg_index, not migration text) ----
    const idx = (await poolC.query(
      `SELECT c.relname AS tbl, i.indisunique, (i.indpred IS NOT NULL) AS is_partial,
              i.indkey::text AS indkey, pg_get_expr(i.indpred, i.indrelid) AS indpred
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
        WHERE c.relname = 'dining_sessions'
          AND i.indexrelid = 'dining_sessions_live_table_idx'::regclass`,
    )).rows[0] as {
      tbl: string;
      indisunique: boolean;
      is_partial: boolean;
      indkey: string;
      indpred: string;
    };
    assertTrue(!!idx, "dining_sessions_live_table_idx exists");
    assertTrue(idx.indisunique, "index is UNIQUE");
    assertTrue(idx.is_partial, "index is PARTIAL");
    assertEqual(idx.indkey, "3", "index is on table_id (attribute 3 of dining_sessions)");
    assertTrue(
      /OPEN/.test(idx.indpred) && /ACTIVE/.test(idx.indpred) && /BILL_REQUESTED/.test(idx.indpred) && /PAYMENT_PENDING/.test(idx.indpred),
      "partial predicate covers live statuses OPEN/ACTIVE/BILL_REQUESTED/PAYMENT_PENDING",
    );
    assertTrue(!/CLOSED/.test(idx.indpred), "partial predicate excludes CLOSED");
    console.log(`  INDEX PRECONDITION: ${idx.indisunique ? "UNIQUE" : "non-unique"} PARTIAL btree on table_id, live predicate verified`);

    // ---- minimal real-PG fixture: two users, one active restaurant, one
    // eligible table, NO existing live session ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerA}, ${`itrack-userA-${randomUUID()}`})`,
    );
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerB}, ${`itrack-userB-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerA}, ${`I7.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
      VALUES (${tableId}, ${restaurantId}, ${label}, ${tableToken})
    `);
    const preLive = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM dining_sessions WHERE table_id = ${tableId}`,
    )).rows[0]?.c as number;
    assertNum(preLive, 0, "precondition: no existing dining_session for the table");
    console.log("FIXTURE OK: two distinct users A/B + active restaurant + one eligible table; no live session yet");

    // ---- two independent service backends ----
    const tableLocked = deferred();
    const releaseA = deferred();
    const portA = new GatedTableLockTransactionPort(
      new DrizzleDineInTransactionPort(drizzle(poolA) as unknown as DrizzleDb),
      async () => {
        tableLocked.resolve();
        await releaseA.promise;
      },
    );
    const portB = new DrizzleDineInTransactionPort(drizzle(poolB) as unknown as DrizzleDb);
    const serviceA = new DiningSessionService(portA, async () => {});
    const serviceB = new DiningSessionService(portB, async () => {});

    // ---- race: same table token, distinct users ----
    const promiseA = serviceA.openSession({
      caller_user_id: ownerA,
      table_token: tableToken,
      correlation_id: `i7.1-A-${randomUUID()}`,
    });
    await tableLocked.promise;
    console.log("[A] openSession A holds the restaurant_tables row FOR UPDATE lock (paused)");

    const promiseB = serviceB.openSession({
      caller_user_id: ownerB,
      table_token: tableToken,
      correlation_id: `i7.1-B-${randomUUID()}`,
    });

    // ---- prove B physically waits on the table row lock ----
    const blocked = await waitUntilBlocked(poolC, "itrack7B", 5000);
    assertEqual(blocked.wait_event_type, "Lock", "openSession B backend blocked on a row lock");
    assertEqual(blocked.wait_event, "transactionid", "openSession B waits on the FIRST transaction's row lock (lockByToken FOR UPDATE)");
    console.log(`[B] openSession B backend blocked: wait_event_type=${blocked.wait_event_type} wait_event=${blocked.wait_event} state=${blocked.state}`);

    // ---- release A: first openSession creates the live session + commits ----
    releaseA.resolve();
    const outcomeA = await promiseA;
    assertTrue(outcomeA.kind === "NEW_MUTATION", "openSession A committed a NEW_MUTATION (created live session)");
    console.log(`[A] openSession A committed: created session ${outcomeA.kind === "NEW_MUTATION" ? outcomeA.value.session.id : "(none)"} owner=${ownerA} status=${outcomeA.kind === "NEW_MUTATION" ? outcomeA.value.session.status : "(none)"}`);

    // ---- B: after unblocking, re-reads occupancy, must NOT create a second
    // live session; accepted static conflict TABLE_OCCUPIED 409 ----
    let outcomeB: MutationOutcome<OpenSessionResult, DineInEventFact> | null = null;
    let rejectedB: unknown = null;
    try {
      outcomeB = await promiseB;
    } catch (err) {
      rejectedB = err;
    }
    assertTrue(rejectedB !== null, "openSession B did not create a second live session");
    assertTrue(
      rejectedB instanceof AppError && rejectedB.code === "TABLE_OCCUPIED" && rejectedB.status === 409,
      "openSession B rejected with accepted static conflict TABLE_OCCUPIED 409",
    );
    console.log(`[B] openSession B rejected: code=TABLE_OCCUPIED status=409 (rejectedB instanceof AppError: ${rejectedB instanceof AppError})`);
    if (outcomeB !== null) {
      throw new Error(`I7.1 unexpected: openSession B resolved with ${JSON.stringify(outcomeB)}`);
    }

    // ---- committed live cardinality: exactly one ----
    const liveRows = (await setup.execute(
      sql`SELECT id, owner_user_id, status FROM dining_sessions WHERE table_id = ${tableId}`,
    )).rows as Array<{ id: string; owner_user_id: string; status: string }>;
    assertNum(liveRows.length, 1, "committed live cardinality for table = exactly 1");
    assertEqual(liveRows[0]!.owner_user_id, ownerA, "winning session owner = A");
    assertEqual(liveRows[0]!.status, "OPEN", "winning session status = OPEN");
    console.log(`COMMITTED LIVE CARDINALITY: 1 live session (id=${liveRows[0]!.id} owner=A status=OPEN); no hidden second live row`);
    console.log(`MECHANISM: accepted openSession flow is LOCK-SERIALIZED on the restaurant_tables row (lockByToken FOR UPDATE first); the live-session UNIQUE index is a DB backstop, not the race arbiter`);

    // ---- direct DB backstop proof (separate transaction, NO service logic):
    // attempt to insert a SECOND live row for the same table ----
    const client = await poolC.connect();
    try {
      await client.query("BEGIN");
      let backstopError: { code?: string; constraint?: string } | null = null;
      try {
        await client.query(
          `INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
           VALUES ($1, $2, $3, $4, 'OPEN')`,
          [randomUUID(), restaurantId, tableId, ownerB],
        );
      } catch (err) {
        backstopError = err as { code?: string; constraint?: string };
      }
      assertTrue(backstopError !== null, "direct DB backstop: second live insert rejected");
      assertEqual(backstopError?.code, "23505", "direct DB backstop: unique_violation (23505)");
      assertEqual(backstopError?.constraint, "dining_sessions_live_table_idx", "direct DB backstop: constraint is dining_sessions_live_table_idx");
      console.log("DIRECT DB BACKSTOP PROOF: second live row rejected by the physical partial unique index (23505)");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // ---- partial-index status boundary: one CLOSED historical session may
    // coexist with the live session (CLOSED excluded from the predicate) ----
    const closedId = randomUUID();
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status, closed_at)
      VALUES (${closedId}, ${restaurantId}, ${tableId}, ${ownerB}, 'CLOSED', ${new Date().toISOString()})
    `);
    const afterClosed = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM dining_sessions WHERE table_id = ${tableId}`,
    )).rows[0]?.c as number;
    assertNum(afterClosed, 2, "partial-index boundary: CLOSED historical session coexists with live session (2 rows total)");
    console.log("PARTIAL-INDEX STATUS BOUNDARY: CLOSED session coexists with the live session (CLOSED excluded from predicate)");

    // ---- cleanup ----
    await setup.execute(sql`DELETE FROM dining_sessions WHERE table_id = ${tableId}`);
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE id = ${tableId}`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id = ${restaurantId}`);
    await setup.execute(sql`DELETE FROM users WHERE id IN (${ownerA}, ${ownerB})`);
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

    console.log("I7.1 LIVE-SESSION UNIQUE RACE PROOF OK");
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
