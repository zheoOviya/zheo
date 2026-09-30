// ============================================================
// EVT-B1 — Real PostgreSQL durable event-outbox proof harness (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgEventOutboxRelay.ts
//
// Proves (and only claims), against real PostgreSQL:
//   A. transaction rollback: business write + outbox insert roll back together
//      (the enqueue primitive shares the caller's transaction; no autocommit)
//   B. a committed PENDING row is claimable by a later worker
//   C. a CLAIMED row whose worker died before publish is reclaimed after lease
//   D. a throwing publish leaves the row present and schedules a retry
//   E. a succeeding publish deletes the row (durable completion)
//   F. reclaim/retry preserves the SAME persisted event_id (no UUID re-mint)
//   G. two concurrent claimers never receive the same due row (SKIP LOCKED)
//
// Does NOT claim: producer wiring (EVT-B2), consumer idempotency (EVT-C),
// exactly-once delivery (DELIVERY = AT_LEAST_ONCE by design).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import { enqueueDomainEvent, DrizzleEventOutboxRepository } from "../src/repositories/drizzle/drizzleEventOutboxRepository";
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

const EVENT_PREFIX = "itrack-evt-";

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function envelope(eventId: string): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: "OrderPickedUp",
    aggregate_id: "discovery",
    timestamp: new Date(),
    payload: { order_id: "itrack-order" },
    metadata: { correlation_id: "itrack-corr" },
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

async function rowFor(db: DrizzleDb, eventId: string): Promise<Record<string, unknown> | null> {
  const res = (await (db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
    sql`SELECT id, event_id, event_name, status, attempts, next_attempt_at
          FROM event_outbox WHERE event_id = ${eventId}`,
  )) as { rows: unknown[] };
  return (res.rows[0] as Record<string, unknown>) ?? null;
}

async function cleanup(db: DrizzleDb, eventIds: string[]): Promise<void> {
  for (const id of eventIds) {
    await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
      sql`DELETE FROM event_outbox WHERE event_id = ${id}`,
    );
  }
  await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
    sql`DELETE FROM itrack_outbox_business WHERE note LIKE ${EVENT_PREFIX + "%"}`,
  );
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url, max: 2 });
  const poolB = new Pool({ connectionString: url, max: 1 });
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const dbB = drizzle(poolB) as unknown as DrizzleDb;

  const created: string[] = [];
  const exec = (db: DrizzleDb, q: unknown) =>
    (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(q);

  try {
    await exec(
      dbA,
      sql`CREATE TABLE IF NOT EXISTS itrack_outbox_business (
            id text PRIMARY KEY,
            note text NOT NULL
          )`,
    );

    // ---------------------------------------------------------
    // A. transaction rollback (business write + outbox insert)
    // ---------------------------------------------------------
    const rollbackId = randomUUID();
    const bizRollback = randomUUID();
    let threw = false;
    try {
      await (
        dbA as unknown as {
          transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
        }
      ).transaction(async (tx) => {
        await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
          sql`INSERT INTO itrack_outbox_business (id, note) VALUES (${bizRollback}, ${EVENT_PREFIX + "rollback"})`,
        );
        await enqueueDomainEvent(tx as DrizzleDb, envelope(rollbackId));
        throw new Error("forced_rollback");
      });
    } catch {
      threw = true;
    }
    check(threw, "A1 forced rollback surfaced (transaction rejected)");
    check((await rowFor(dbA, rollbackId)) === null, "A2 outbox insert rolled back with the business write");
    const bizLeft = (await (
      dbA as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }
    ).execute(sql`SELECT id FROM itrack_outbox_business WHERE id = ${bizRollback}`)) as {
      rows: unknown[];
    };
    check(bizLeft.rows.length === 0, "A3 business write rolled back");

    // ---------------------------------------------------------
    // A'. committed transaction persists BOTH
    // ---------------------------------------------------------
    const commitId = randomUUID();
    created.push(commitId);
    const bizCommit = randomUUID();
    await (
      dbA as unknown as {
        transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      }
    ).transaction(async (tx) => {
      await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`INSERT INTO itrack_outbox_business (id, note) VALUES (${bizCommit}, ${EVENT_PREFIX + "commit"})`,
      );
      await enqueueDomainEvent(tx as DrizzleDb, envelope(commitId));
    });
    const committed = await rowFor(dbA, commitId);
    check(committed !== null && committed.status === "PENDING" && Number(committed.attempts) === 0,
      "A4 committed transaction persists a PENDING outbox row with attempts=0");

    // ---------------------------------------------------------
    // B/C. committed PENDING is claimed; dead worker's CLAIMED row is reclaimed
    // ---------------------------------------------------------
    const repoA = new DrizzleEventOutboxRepository(dbA);
    let clock = Date.now();
    const now = () => new Date(clock);
    const LEASE = 30_000;

    const claimed1 = await repoA.claimDue({ limit: 50, now: now(), leaseMs: LEASE });
    const gotCommit = claimed1.find((r) => r.event_id === commitId);
    check(gotCommit !== undefined && gotCommit.status === "CLAIMED", "B1 later worker claims the committed PENDING row");

    // worker "dies" before publish: no ack. Advance past the lease and reclaim.
    clock += LEASE + 1;
    const reclaimed = await repoA.claimDue({ limit: 50, now: now(), leaseMs: LEASE });
    const gotAgain = reclaimed.find((r) => r.event_id === commitId);
    check(gotAgain !== undefined, "C1 expired CLAIMED row is reclaimed after lease expiry");
    check(gotAgain !== undefined && outboxRowToEnvelope(gotAgain).event_id === commitId,
      "F1 reclaim preserves the SAME persisted event_id");

    // isolate the relay phase to a single row
    await cleanup(dbA, [commitId]);

    // ---------------------------------------------------------
    // D/E/F. relay publish failure -> retry; success -> delete; id stable
    // ---------------------------------------------------------
    clock += LEASE + 1; // make the relay row due
    const relayId = randomUUID();
    created.push(relayId);
    await (
      dbA as unknown as {
        transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      }
    ).transaction(async (tx) => {
      await enqueueDomainEvent(tx as DrizzleDb, envelope(relayId));
    });

    const publishedIds: string[] = [];
    const failingRelay = new EventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      now,
      leaseMs: LEASE,
      publish: async () => {
        throw new Error("transport_down");
      },
    });
    const failTick = await failingRelay.tick();
    check(failTick.retried >= 1, "D1 throwing publish schedules a bounded retry");
    const afterFail = await rowFor(dbA, relayId);
    check(afterFail !== null && afterFail.status === "PENDING" && Number(afterFail.attempts) === 1,
      "D2 failed publish keeps the row (not deleted) and increments attempts");

    const nextAt = afterFail ? Date.parse(String(afterFail.next_attempt_at)) : 0;
    clock = nextAt + 1;
    const okRelay = new EventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      now,
      leaseMs: LEASE,
      publish: async (env) => {
        publishedIds.push(env.event_id);
      },
    });
    const okTick = await okRelay.tick();
    check(okTick.published >= 1, "E1 succeeding publish is completed");
    check((await rowFor(dbA, relayId)) === null, "E2 successful publish deletes the outbox row");
    check(publishedIds.includes(relayId), "F2 relay republished the SAME persisted event_id");

    // ---------------------------------------------------------
    // G. concurrent claimers: exactly one receives a due row
    // ---------------------------------------------------------
    const conId = randomUUID();
    created.push(conId);
    await (
      dbA as unknown as {
        transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      }
    ).transaction(async (tx) => {
      await enqueueDomainEvent(tx as DrizzleDb, envelope(conId));
    });

    const conRepoA = new DrizzleEventOutboxRepository(dbA);
    const conRepoB = new DrizzleEventOutboxRepository(dbB);
    const [resA, resB] = await Promise.all([
      conRepoA.claimDue({ limit: 50, now: now(), leaseMs: LEASE }),
      conRepoB.claimDue({ limit: 50, now: now(), leaseMs: LEASE }),
    ]);
    const winners = [...resA, ...resB].filter((r) => r.event_id === conId);
    check(winners.length === 1, `G1 exactly one of two concurrent claimers received the due row (got ${winners.length})`);

    await cleanup(dbA, created);
  } finally {
    await poolA.end();
    await poolB.end();
  }

  if (failures > 0) {
    console.error(`EVT-B1 REAL-PG HARNESS FAILED (${failures} check(s))`);
    process.exitCode = 1;
  } else {
    console.log("EVT-B1 REAL-PG HARNESS: ALL CHECKS PASSED");
  }
}

main().catch((err) => {
  console.error("EVT-B1 REAL-PG HARNESS ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
