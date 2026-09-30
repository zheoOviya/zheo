// ============================================================
// EVT-C1 — Real PostgreSQL durable consumer-inbox proof (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with an explicit disposable DATABASE_URL, after applying migration
// 0027 (the event_consumer_dedup table):
//
//   psql "$DATABASE_URL" -f packages/db/drizzle/0027_fine_ben_urich.sql
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_b1_run \
//   pnpm exec tsx apps/api/integration/realPgEventConsumerDedup.ts
//
// Proves, against real PostgreSQL:
//
//   C1-1  first (consumer,event_id) insert succeeds
//   C1-2  duplicate same pair does not create a second marker
//   C1-3  same event_id + different consumer is allowed
//   C1-4  same consumer + different event_id is allowed
//   C1-6  tx-scoped marker rolls back with the caller transaction, and commits
//         with it
//   C1-7  the PK is exactly (consumer_name, event_id) (duplicate raw insert
//         raises 23505 on that constraint)
//   C1-8  processed_at is durable (NOT NULL, parseable, stable on re-read)
//
// Memory mode cannot prove C1-6 transactional atomicity; this harness is the
// required evidence.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleEventConsumerDedupRepository } from "../src/repositories/drizzle/drizzleEventConsumerDedupRepository";
import { markProcessedInTx } from "../src/repositories/drizzle/drizzleEventConsumerDedupRepository";

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

const PREFIX = "itrack-c1-";
const CONSUMER_A = PREFIX + "retention.cashback";
const CONSUMER_B = PREFIX + "loyalty.order_stamp";

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

async function countFor(
  db: DrizzleDb,
  consumer: string,
  eventId: string,
): Promise<number> {
  const res = (await exec(
    db,
    sql`SELECT count(*)::text AS n FROM event_consumer_dedup
        WHERE consumer_name = ${consumer} AND event_id = ${eventId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0]?.n ?? "0");
}

async function processedAtFor(
  db: DrizzleDb,
  consumer: string,
  eventId: string,
): Promise<string | null> {
  const res = (await exec(
    db,
    sql`SELECT processed_at FROM event_consumer_dedup
        WHERE consumer_name = ${consumer} AND event_id = ${eventId}`,
  )) as unknown as { rows: { processed_at: Date | string }[] };
  const v = res.rows[0]?.processed_at;
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

async function cleanup(db: DrizzleDb): Promise<void> {
  await exec(
    db,
    sql`DELETE FROM event_consumer_dedup WHERE consumer_name LIKE ${PREFIX + "%"}`,
  );
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const repo = new DrizzleEventConsumerDedupRepository(db);

  try {
    // Precondition: the EVT-C1 migration table is present.
    const present = (await exec(
      db,
      sql`SELECT to_regclass('event_consumer_dedup') IS NOT NULL AS ok`,
    )) as unknown as { rows: { ok: boolean }[] };
    check(present.rows[0]?.ok === true, "C1-0 event_consumer_dedup table present");

    // ---------------------------------------------------------
    // C1-1 first insert succeeds
    // ---------------------------------------------------------
    const e1 = randomUUID();
    check((await repo.hasProcessed(CONSUMER_A, e1)) === false, "C1-1 pre-state hasProcessed=false");
    await repo.markProcessed(CONSUMER_A, e1);
    check((await repo.hasProcessed(CONSUMER_A, e1)) === true, "C1-1 markProcessed -> hasProcessed=true");
    check((await countFor(db, CONSUMER_A, e1)) === 1, "C1-1 exactly one row persisted");

    // ---------------------------------------------------------
    // C1-2 duplicate same pair adds no second marker
    // ---------------------------------------------------------
    await repo.markProcessed(CONSUMER_A, e1);
    await repo.markProcessed(CONSUMER_A, e1);
    check((await countFor(db, CONSUMER_A, e1)) === 1, "C1-2 duplicate pair stays at one row");

    // ---------------------------------------------------------
    // C1-3 same event_id + different consumer allowed
    // ---------------------------------------------------------
    await repo.markProcessed(CONSUMER_B, e1);
    check((await countFor(db, CONSUMER_B, e1)) === 1, "C1-3 different consumer same event persists");
    check(
      (await repo.hasProcessed(CONSUMER_A, e1)) && (await repo.hasProcessed(CONSUMER_B, e1)),
      "C1-3 both consumers marked for the same event_id",
    );

    // ---------------------------------------------------------
    // C1-4 same consumer + different event_id allowed
    // ---------------------------------------------------------
    const e2 = randomUUID();
    await repo.markProcessed(CONSUMER_A, e2);
    check((await countFor(db, CONSUMER_A, e2)) === 1, "C1-4 different event_id same consumer persists");

    // ---------------------------------------------------------
    // C1-6a tx-scoped marker ROLLS BACK with the caller transaction
    // ---------------------------------------------------------
    const eRollback = randomUUID();
    let rolledBack = false;
    try {
      await (
        db as unknown as {
          transaction: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>;
        }
      ).transaction(async (tx) => {
        await markProcessedInTx(tx, CONSUMER_A, eRollback);
        throw new Error("itrack-c1-force-rollback");
      });
    } catch {
      rolledBack = true;
    }
    check(rolledBack, "C1-6a rollback tx callback threw");
    check(
      (await countFor(db, CONSUMER_A, eRollback)) === 0,
      "C1-6a tx-scoped marker rolled back (zero rows)",
    );
    check(
      (await repo.hasProcessed(CONSUMER_A, eRollback)) === false,
      "C1-6a hasProcessed=false after rollback",
    );

    // ---------------------------------------------------------
    // C1-6b tx-scoped marker COMMITS with the caller transaction
    // ---------------------------------------------------------
    const eCommit = randomUUID();
    await (
      db as unknown as {
        transaction: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>;
      }
    ).transaction(async (tx) => {
      await markProcessedInTx(tx, CONSUMER_A, eCommit);
    });
    check(
      (await countFor(db, CONSUMER_A, eCommit)) === 1,
      "C1-6b tx-scoped marker committed (one row)",
    );
    check(
      (await repo.hasProcessed(CONSUMER_A, eCommit)) === true,
      "C1-6b hasProcessed=true after commit",
    );

    // ---------------------------------------------------------
    // C1-7 PK is exactly (consumer_name, event_id)
    // ---------------------------------------------------------
    const ePk = randomUUID();
    await repo.markProcessed(CONSUMER_A, ePk);
    let violationCode: string | undefined;
    let violationConstraint: string | undefined;
    try {
      await exec(
        db,
        sql`INSERT INTO event_consumer_dedup (consumer_name, event_id)
            VALUES (${CONSUMER_A}, ${ePk})`,
      );
    } catch (err) {
      const e = ((err as { cause?: unknown }).cause ?? err) as {
        code?: string;
        constraint?: string;
      };
      violationCode = e.code;
      violationConstraint = e.constraint;
    }
    check(violationCode === "23505", "C1-7 raw duplicate insert raises 23505");
    check(
      violationConstraint === "event_consumer_dedup_consumer_name_event_id_pk",
      "C1-7 violation is on the (consumer_name,event_id) PK",
    );

    // ---------------------------------------------------------
    // C1-8 processed_at is durable
    // ---------------------------------------------------------
    const first = await processedAtFor(db, CONSUMER_A, e1);
    check(first !== null && !Number.isNaN(Date.parse(first)), "C1-8 processed_at is set and parseable");
    const second = await processedAtFor(db, CONSUMER_A, e1);
    check(second === first, "C1-8 processed_at stable on re-read (durable)");
  } finally {
    await cleanup(db);
    await pool.end();
  }

  if (failures > 0) {
    console.error(`RESULT: FAIL (${failures} failed)`);
    process.exit(1);
  }
  console.log("RESULT: PASS (all C1 real-PG consumer inbox checks)");
}

void main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
