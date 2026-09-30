// ============================================================
// EVT-B2A — Real PostgreSQL producer transaction-boundary proof (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgProducerOutboxBoundary.ts
//
// Proves, against real PostgreSQL, that the EVT-B2A producer transaction ports
// run `outbox.enqueue` on the SAME transaction handle as the business mutation:
//
//   B2A-PG1 fulfillment port COMMIT  -> exactly one PENDING row persisted
//   B2A-PG2 fulfillment port ROLLBACK (callback throws after enqueue)
//                                    -> zero rows persisted (no autocommit leak)
//   B2A-PG3 vendor-approval port COMMIT -> exactly one PENDING row persisted
//   B2A-PG4 vendor-approval port ROLLBACK -> zero rows persisted
//   B2A-PG5 business write + outbox insert in one raw tx roll back together
//   B2A-PG6 persisted event_id survives outboxRowToEnvelope reconstruction and
//            a relay publish (no UUID re-mint) and the row is deleted on success
//
// Does NOT claim: consumer idempotency (EVT-C), exactly-once delivery
// (DELIVERY = AT_LEAST_ONCE by design), or the full HTTP approve/pickup flow.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleFulfillmentTransactionPort } from "../src/repositories/drizzle/fulfillmentTransactionPort";
import { DrizzleVendorApprovalTransactionPort } from "../src/repositories/drizzle/vendorApprovalTransactionPort";
import {
  DrizzleEventOutboxRepository,
  enqueueDomainEvent,
} from "../src/repositories/drizzle/drizzleEventOutboxRepository";
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

const BIZ_PREFIX = "itrack-b2a-";

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
  await exec(db, sql`DELETE FROM itrack_b2a_business WHERE note LIKE ${BIZ_PREFIX + "%"}`);
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool) as unknown as DrizzleDb;

  const created: string[] = [];

  try {
    await exec(
      db,
      sql`CREATE TABLE IF NOT EXISTS itrack_b2a_business (
            id text PRIMARY KEY,
            note text NOT NULL
          )`,
    );

    // ---------------------------------------------------------
    // B2A-PG1 fulfillment port COMMIT persists exactly one row
    // ---------------------------------------------------------
    const fCommit = randomUUID();
    created.push(fCommit);
    const fPort = new DrizzleFulfillmentTransactionPort(db);
    await fPort.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(fCommit, "OrderPickedUp", BIZ_PREFIX + "order-commit"));
    });
    check((await countFor(db, fCommit)) === 1, "B2A-PG1 fulfillment commit persists exactly one row");
    check((await statusFor(db, fCommit)) === "PENDING", "B2A-PG1 persisted row status = PENDING");

    // ---------------------------------------------------------
    // B2A-PG2 fulfillment port ROLLBACK persists zero rows
    // ---------------------------------------------------------
    const fRollback = randomUUID();
    created.push(fRollback);
    let fThrew = false;
    try {
      await fPort.runInTransaction(async ({ outbox }) => {
        await outbox.enqueue(envelope(fRollback, "GiftFulfilled", BIZ_PREFIX + "gift-rollback"));
        throw new Error("itrack-force-rollback");
      });
    } catch {
      fThrew = true;
    }
    check(fThrew, "B2A-PG2 fulfillment rollback callback threw");
    check(
      (await countFor(db, fRollback)) === 0,
      "B2A-PG2 fulfillment rollback persists zero rows (enqueue shares tx)",
    );

    // ---------------------------------------------------------
    // B2A-PG3 vendor-approval port COMMIT persists exactly one row
    // ---------------------------------------------------------
    const vCommit = randomUUID();
    created.push(vCommit);
    const vPort = new DrizzleVendorApprovalTransactionPort(db);
    await vPort.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(
        envelope(vCommit, "VendorApplicationApproved", BIZ_PREFIX + "app-commit"),
      );
    });
    check((await countFor(db, vCommit)) === 1, "B2A-PG3 vendor commit persists exactly one row");
    check((await statusFor(db, vCommit)) === "PENDING", "B2A-PG3 persisted row status = PENDING");

    // ---------------------------------------------------------
    // B2A-PG4 vendor-approval port ROLLBACK persists zero rows
    // ---------------------------------------------------------
    const vRollback = randomUUID();
    created.push(vRollback);
    let vThrew = false;
    try {
      await vPort.runInTransaction(async ({ outbox }) => {
        await outbox.enqueue(
          envelope(vRollback, "VendorApplicationRejected", BIZ_PREFIX + "app-rollback"),
        );
        throw new Error("itrack-force-rollback");
      });
    } catch {
      vThrew = true;
    }
    check(vThrew, "B2A-PG4 vendor rollback callback threw");
    check(
      (await countFor(db, vRollback)) === 0,
      "B2A-PG4 vendor rollback persists zero rows (enqueue shares tx)",
    );

    // ---------------------------------------------------------
    // B2A-PG5 business write + outbox insert roll back together (raw tx)
    // ---------------------------------------------------------
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
          sql`INSERT INTO itrack_b2a_business (id, note) VALUES (${bizId}, ${BIZ_PREFIX + "biz"})`,
        );
        await enqueueDomainEvent(tx, envelope(bizEvent, "OrderPickedUp", BIZ_PREFIX + "biz"));
        throw new Error("itrack-force-rollback");
      });
    } catch {
      bizThrew = true;
    }
    const bizRes = (await exec(
      db,
      sql`SELECT count(*)::text AS n FROM itrack_b2a_business WHERE id = ${bizId}`,
    )) as unknown as { rows: { n: string }[] };
    check(bizThrew, "B2A-PG5 combined tx callback threw");
    check(
      Number(bizRes.rows[0]?.n ?? "0") === 0,
      "B2A-PG5 business row rolled back with the outbox insert",
    );
    check((await countFor(db, bizEvent)) === 0, "B2A-PG5 outbox row rolled back with business row");

    // ---------------------------------------------------------
    // B2A-PG6 event_id preserved through reconstruction + relay
    // ---------------------------------------------------------
    const stableId = randomUUID();
    created.push(stableId);
    await fPort.runInTransaction(async ({ outbox }) => {
      await outbox.enqueue(envelope(stableId, "OrderPickedUp", BIZ_PREFIX + "stable"));
    });
    const rowRes = (await exec(
      db,
      sql`SELECT * FROM event_outbox WHERE event_id = ${stableId}`,
    )) as unknown as { rows: Record<string, unknown>[] };
    const row = rowRes.rows[0];
    if (!row) throw new Error("stable row missing");
    const reconstructed = outboxRowToEnvelope(row as never);
    check(reconstructed.event_id === stableId, "B2A-PG6 reconstruction preserves persisted event_id");

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
    check(published.includes(stableId), "B2A-PG6 relay publishes the persisted event_id");
    check((await countFor(db, stableId)) === 0, "B2A-PG6 row deleted after successful publish");
  } finally {
    await cleanup(db, created);
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all B2A real-PG producer boundary checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
