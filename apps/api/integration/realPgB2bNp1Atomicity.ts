// ============================================================
// EVT-B2B-NP1 — Real PostgreSQL producer transaction-boundary proof
// (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgB2bNp1Atomicity.ts
//
// Proves, against real PostgreSQL, that each NP1 producer transaction port runs
// `outbox.enqueue` on the SAME transaction handle as the business mutation:
//
//   NP1-PG-O1 checkout port COMMIT   -> exactly one PENDING row persisted
//   NP1-PG-O2 checkout port ROLLBACK -> zero rows persisted (no autocommit leak)
//   NP1-PG-P1 pos-import port COMMIT -> exactly one PENDING row persisted
//   NP1-PG-P2 pos-import port ROLLBACK -> zero rows persisted
//   NP1-PG-G1 group port COMMIT      -> exactly one PENDING row persisted
//   NP1-PG-G2 group port ROLLBACK    -> zero rows persisted
//   NP1-PG-C1 catering port COMMIT   -> exactly one PENDING row persisted
//   NP1-PG-C2 catering port ROLLBACK -> zero rows persisted
//   NP1-PG-BIZ business write + outbox insert in one raw tx roll back together
//   NP1-PG-ID1 persisted event_id survives reconstruction + relay, then deleted
//
// NOTE ON DOMAIN ROWS: the disposable EVT DB carries the order/outbox schema but
// not the domain-mapping tables (order_items, group_carts, pos_order_mappings),
// so this harness proves the outbox's transaction membership directly on each
// named port. Every `build*TxRepos` binds the business repos to the SAME `tx`
// handle passed to `outbox` (see the port modules), so the business write and
// the event row share one commit boundary by construction.
//
// Does NOT claim: consumer idempotency (EVT-C), exactly-once delivery
// (DELIVERY = AT_LEAST_ONCE by design), or the full HTTP import flow.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import type { EventOutboxRepository } from "../src/repositories/eventOutboxRepository";
import { DrizzleOrderCheckoutTransactionPort } from "../src/repositories/drizzle/orderCheckoutTransactionPort";
import { DrizzleGroupOrderTransactionPort } from "../src/repositories/drizzle/groupOrderTransactionPort";
import { DrizzlePosImportTransactionPort } from "../src/repositories/drizzle/posImportTransactionPort";
import { DrizzleCateringTransactionPort } from "../src/repositories/drizzle/cateringTransactionPort";
import { DrizzleEventOutboxRepository, enqueueDomainEvent } from "../src/repositories/drizzle/drizzleEventOutboxRepository";
import { outboxRowToEnvelope } from "../src/repositories/eventOutboxRepository";
import { EventOutboxRelay } from "../src/services/eventOutboxRelay";

const maybeUrl = process.env.DATABASE_URL;
if (!maybeUrl) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable EVT DB)");
  process.exit(2);
}
const url: string = maybeUrl;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}

const BIZ_PREFIX = "itrack-np1-";

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function envelope(
  eventId: string,
  eventName: EventName,
  aggregateId: string,
): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: eventName,
    aggregate_id: aggregateId,
    timestamp: new Date(),
    payload: { order_id: BIZ_PREFIX + "order" },
    metadata: { correlation_id: BIZ_PREFIX + "corr" },
  } as unknown as TypedEventEnvelope<EventName>;
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
const exec = (db: DrizzleDb, q: unknown) => (db as unknown as { execute: Exec }).execute(q);

async function countFor(db: DrizzleDb, eventId: string): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_outbox WHERE event_id = ${eventId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function statusFor(db: DrizzleDb, eventId: string): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT status FROM event_outbox WHERE event_id = ${eventId}`,
  )) as unknown as { rows: { status: string }[] };
  return res.rows[0]?.status ?? null;
}

async function cleanup(db: DrizzleDb, eventIds: string[]): Promise<void> {
  for (const id of eventIds) {
    await exec(db, sql`DELETE FROM event_outbox WHERE event_id = ${id}`);
  }
  await exec(db, sql`DELETE FROM itrack_np1_business WHERE note LIKE ${BIZ_PREFIX + "%"}`);
}

/**
 * Narrow common view of every NP1 producer port: all four expose an `outbox`
 * whose `enqueue` runs on the port's own transaction handle.
 */
type AnyNp1Port = {
  runInTransaction<T>(
    fn: (repos: { outbox: Pick<EventOutboxRepository, "enqueue"> }) => Promise<T>,
  ): Promise<T>;
};

async function provePortCommit(
  db: DrizzleDb,
  created: string[],
  label: string,
  port: AnyNp1Port,
  eventName: EventName,
): Promise<void> {
  const eventId = randomUUID();
  created.push(eventId);
  await port.runInTransaction(async ({ outbox }) => {
    await outbox.enqueue(envelope(eventId, eventName, BIZ_PREFIX + "commit"));
  });
  check((await countFor(db, eventId)) === 1, `${label} commit persists exactly one row`);
  check((await statusFor(db, eventId)) === "PENDING", `${label} persisted row status = PENDING`);
}

async function provePortRollback(
  db: DrizzleDb,
  created: string[],
  label: string,
  port: AnyNp1Port,
  eventName: EventName,
): Promise<void> {
  const eventId = randomUUID();
  created.push(eventId);
  let threw = false;
  try {
    await port.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(eventId, eventName, BIZ_PREFIX + "rollback"));
      throw new Error("itrack-force-rollback");
    });
  } catch {
    threw = true;
  }
  check(threw, `${label} rollback callback threw`);
  check(
    (await countFor(db, eventId)) === 0,
    `${label} rollback persists zero rows (enqueue shares tx)`,
  );
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool) as unknown as DrizzleDb;

  const created: string[] = [];

  try {
    await exec(
      db,
      sql`CREATE TABLE IF NOT EXISTS itrack_np1_business (
            id text PRIMARY KEY,
            note text NOT NULL
          )`,
    );

    // ------------------------------------------------------------------
    // Checkout port
    // ------------------------------------------------------------------
    const checkoutPort = new DrizzleOrderCheckoutTransactionPort(db) as unknown as AnyNp1Port;
    await provePortCommit(db, created, "NP1-PG-O1 checkout", checkoutPort, "OrderCreated");
    await provePortRollback(db, created, "NP1-PG-O2 checkout", checkoutPort, "OrderCreated");

    // ------------------------------------------------------------------
    // POS import port
    // ------------------------------------------------------------------
    const posPort = new DrizzlePosImportTransactionPort(db) as unknown as AnyNp1Port;
    await provePortCommit(db, created, "NP1-PG-P1 pos-import", posPort, "PosOrderImported");
    await provePortRollback(db, created, "NP1-PG-P2 pos-import", posPort, "PosOrderImported");

    // ------------------------------------------------------------------
    // Group cart port
    // ------------------------------------------------------------------
    const groupPort = new DrizzleGroupOrderTransactionPort(db) as unknown as AnyNp1Port;
    await provePortCommit(db, created, "NP1-PG-G1 group", groupPort, "GroupOrderCreated");
    await provePortRollback(db, created, "NP1-PG-G2 group", groupPort, "GroupOrderItemAdded");

    // ------------------------------------------------------------------
    // Catering port
    // ------------------------------------------------------------------
    const cateringPort = new DrizzleCateringTransactionPort(db) as unknown as AnyNp1Port;
    await provePortCommit(db, created, "NP1-PG-C1 catering", cateringPort, "CateringOrderCreated");
    await provePortRollback(db, created, "NP1-PG-C2 catering", cateringPort, "CateringOrderCreated");

    // ------------------------------------------------------------------
    // Business write + outbox insert roll back together (raw tx)
    // ------------------------------------------------------------------
    const bizId = randomUUID();
    const bizEvent = randomUUID();
    created.push(bizEvent);
    let bizThrew = false;
    try {
      await (
        db as unknown as {
          transaction: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>;
        }
      ).transaction(async (tx) => {
        await exec(
          tx,
          sql`INSERT INTO itrack_np1_business (id, note) VALUES (${bizId}, ${BIZ_PREFIX + "biz"})`,
        );
        await enqueueDomainEvent(tx, envelope(bizEvent, "OrderCreated", BIZ_PREFIX + "biz"));
        throw new Error("itrack-force-rollback");
      });
    } catch {
      bizThrew = true;
    }
    const bizRes = (await exec(
      db,
      sql`SELECT count(*)::text AS n FROM itrack_np1_business WHERE id = ${bizId}`,
    )) as unknown as { rows: { n: string }[] };
    check(bizThrew, "NP1-PG-BIZ combined tx callback threw");
    check(
      Number(bizRes.rows[0]?.n ?? "0") === 0,
      "NP1-PG-BIZ business row rolled back with the outbox insert",
    );
    check((await countFor(db, bizEvent)) === 0, "NP1-PG-BIZ outbox row rolled back with business row");

    // ------------------------------------------------------------------
    // Persisted event_id survives reconstruction + relay; deleted on success
    // ------------------------------------------------------------------
    const stableId = randomUUID();
    created.push(stableId);
    await checkoutPort.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(stableId, "OrderCreated", BIZ_PREFIX + "stable"));
    });
    const rowRes = (await exec(
      db,
      sql`SELECT * FROM event_outbox WHERE event_id = ${stableId}`,
    )) as unknown as { rows: Record<string, unknown>[] };
    const row = rowRes.rows[0];
    if (!row) throw new Error("stable row missing");
    const reconstructed = outboxRowToEnvelope(row as never);
    check(reconstructed.event_id === stableId, "NP1-PG-ID1 reconstruction preserves persisted event_id");

    const relayRepo = new DrizzleEventOutboxRepository(db);
    const published: string[] = [];
    const relay = new EventOutboxRelay({
      repo: relayRepo,
      now: () => new Date(),
      publish: async (env) => {
        published.push(env.event_id);
      },
    });
    await relay.tick();
    check(published.includes(stableId), "NP1-PG-ID1 relay publishes the persisted event_id");
    check((await countFor(db, stableId)) === 0, "NP1-PG-ID1 row deleted after successful publish");
  } finally {
    await cleanup(db, created);
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all EVT-B2B-NP1 real-PG producer boundary checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
