// ============================================================
// EVT-RELAY-BOOTSTRAP — Real PostgreSQL + Real Redis bootstrap proof harness
// (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV with explicit disposable DATABASE_URL and REDIS_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/evt_payb_run \
//   REDIS_URL=redis://127.0.0.1:6379 \
//   pnpm exec tsx apps/api/integration/realPgRedisEventOutboxBootstrap.ts
//
// Principal proof exercises the ACTUAL bootstrap (`startEventOutboxRelay`), not
// a hand-rolled `new EventOutboxRelay(...).tick()` loop:
//   BOOT    — committed PENDING row is delivered to a real Redis subscriber and
//             deleted from Postgres; delivered event_id == persisted event_id
//   RESTART — a row committed while the relay is stopped is delivered once the
//             bootstrap starts again
//   REDIS   — an unavailable Redis transport retains/reschedules the row (not
//             deleted); after recovery a later bootstrap tick delivers the SAME
//             event_id
//   MULTI   — two relay instances race; one claim winner; plus a deliberate
//             replay carries the SAME event_id
//   SHUTDOWN— stop awaits an in-flight tick and no scheduling continues after
//
// Delivery stays AT_LEAST_ONCE. EXACTLY_ONCE is NOT claimed.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import Redis from "ioredis";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../src/lib/dbType";
import {
  enqueueDomainEvent,
  DrizzleEventOutboxRepository,
} from "../src/repositories/drizzle/drizzleEventOutboxRepository";
import { publishDurableEnvelope } from "../src/lib/eventBus";
import { getRedis } from "../src/lib/redis";
import {
  EventOutboxRelay,
  startEventOutboxRelay,
  stopEventOutboxRelay,
} from "../src/services/eventOutboxRelay";

const CHANNEL = "snakzap:events";
const EVENT_PREFIX = "relayboot-";

const maybeDb = process.env.DATABASE_URL;
const maybeRedis = process.env.REDIS_URL;
if (!maybeDb) {
  console.error("FATAL: DATABASE_URL is required (disposable EVT DB)");
  process.exit(2);
}
if (!maybeRedis) {
  console.error("FATAL: REDIS_URL is required (real Redis)");
  process.exit(2);
}
const dbUrl: string = maybeDb;
const redisUrl: string = maybeRedis;
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV");
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

function envelope(eventId: string): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: "OrderPickedUp",
    aggregate_id: "relayboot",
    timestamp: new Date(),
    payload: { order_id: "relayboot" },
    metadata: { correlation_id: "relayboot" },
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  console.error(`TIMEOUT waiting for: ${label}`);
  return false;
}

function exec(db: DrizzleDb, q: unknown): Promise<unknown> {
  return (
    db as unknown as { execute: (query: unknown) => Promise<unknown> }
  ).execute(q);
}

async function rowFor(
  db: DrizzleDb,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const res = (await exec(
    db,
    sql`SELECT id, event_id, status, attempts, next_attempt_at
        FROM event_outbox WHERE event_id = ${eventId}`,
  )) as { rows: unknown[] };
  return (res.rows[0] as Record<string, unknown>) ?? null;
}

async function makeDue(db: DrizzleDb, eventId: string): Promise<void> {
  await exec(
    db,
    sql`UPDATE event_outbox SET status = 'PENDING', next_attempt_at = now()
        WHERE event_id = ${eventId}`,
  );
}

async function enqueueCommitted(db: DrizzleDb, eventId: string): Promise<void> {
  await (
    db as unknown as {
      transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    }
  ).transaction(async (tx) => {
    await enqueueDomainEvent(tx as DrizzleDb, envelope(eventId));
  });
}

async function cleanup(db: DrizzleDb, eventIds: string[]): Promise<void> {
  for (const id of eventIds) {
    await exec(db, sql`DELETE FROM event_outbox WHERE event_id = ${id}`);
  }
}

class AckFailOnceRepository extends DrizzleEventOutboxRepository {
  failOnce = false;
  override async markPublished(id: string): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("crash_after_publish_before_delete");
    }
    return super.markPublished(id);
  }
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log(`REDIS_URL target: ${redisUrl}`);

  const poolA = new Pool({ connectionString: dbUrl, max: 3 });
  const poolB = new Pool({ connectionString: dbUrl, max: 2 });
  const dbA = drizzle(poolA) as unknown as DrizzleDb;

  const created: string[] = [];
  const delivered: string[] = [];
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  subscriber.on("message", (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as { event_id?: string };
      if (parsed.event_id) delivered.push(parsed.event_id);
    } catch {
      // ignore malformed
    }
  });

  const deliveredCount = (id: string): number =>
    delivered.filter((d) => d === id).length;

  // Transport seam pointed at a dead port: a real Redis client whose publish
  // genuinely rejects (connection refused).
  const offlineRedis = new Redis("redis://127.0.0.1:6399", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  offlineRedis.on("error", () => undefined);
  const publishOffline = async (env: TypedEventEnvelope<EventName>): Promise<void> => {
    await offlineRedis.publish(CHANNEL, JSON.stringify(env));
  };

  try {
    await subscriber.subscribe(CHANNEL);

    // ---------------------------------------------------------
    // BOOT DELIVERY (actual bootstrap)
    // ---------------------------------------------------------
    const bootId = randomUUID();
    created.push(bootId);
    await cleanup(dbA, created);
    await enqueueCommitted(dbA, bootId);
    const persisted = await rowFor(dbA, bootId);
    check(
      persisted !== null && persisted.status === "PENDING" && persisted.event_id === bootId,
      `BOOT-1 committed PENDING row persisted (event_id=${bootId})`,
    );

    startEventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      intervalMs: 25,
    });
    const bootDelivered = await waitFor(
      async () => deliveredCount(bootId) >= 1,
      5_000,
      "BOOT delivery to Redis subscriber",
    );
    check(bootDelivered, "BOOT-2 bootstrap delivered the row to a real Redis subscriber");
    check(delivered.includes(bootId), "BOOT-3 delivered event_id equals persisted event_id");
    const bootGone = await waitFor(async () => (await rowFor(dbA, bootId)) === null, 3_000, "BOOT row deleted");
    check(bootGone, "BOOT-4 successful publish deleted the DB row");
    await stopEventOutboxRelay();

    // ---------------------------------------------------------
    // RESTART (row committed while relay stopped)
    // ---------------------------------------------------------
    const restartId = randomUUID();
    created.push(restartId);
    await enqueueCommitted(dbA, restartId);
    check(deliveredCount(restartId) === 0, "RESTART-1 row committed while relay stopped (not delivered yet)");

    startEventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      intervalMs: 25,
    });
    const restartDelivered = await waitFor(
      async () => deliveredCount(restartId) >= 1,
      5_000,
      "RESTART delivery",
    );
    check(restartDelivered, "RESTART-2 bootstrap delivered the pre-existing committed row");
    check(delivered.includes(restartId), "RESTART-3 delivered event_id equals persisted event_id");
    const restartGone = await waitFor(async () => (await rowFor(dbA, restartId)) === null, 3_000, "RESTART row deleted");
    check(restartGone, "RESTART-4 row deleted after delivery");
    await stopEventOutboxRelay();

    // ---------------------------------------------------------
    // REDIS FAILURE then recovery
    // ---------------------------------------------------------
    const outageId = randomUUID();
    created.push(outageId);
    await enqueueCommitted(dbA, outageId);

    startEventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      publish: publishOffline,
      intervalMs: 25,
    });
    const retained = await waitFor(
      async () => {
        const row = await rowFor(dbA, outageId);
        return row !== null && Number(row.attempts) >= 1;
      },
      4_000,
      "REDIS failure retains + reschedules row",
    );
    const outageRow = await rowFor(dbA, outageId);
    check(retained, "REDIS-1 unavailable transport retained the row and scheduled a retry");
    check(outageRow !== null && Number(outageRow.attempts) >= 1, "REDIS-2 attempts incremented (not deleted)");
    check(deliveredCount(outageId) === 0, "REDIS-3 nothing delivered while transport was down");
    await stopEventOutboxRelay();

    // Recover: make the row due and run the good bootstrap.
    await makeDue(dbA, outageId);
    startEventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      intervalMs: 25,
    });
    const recovered = await waitFor(
      async () => deliveredCount(outageId) >= 1,
      6_000,
      "REDIS recovery delivery",
    );
    check(recovered, "REDIS-4 after recovery a later bootstrap tick delivered the SAME event_id");
    check(delivered.includes(outageId), "REDIS-5 recovered delivery carries the persisted event_id");
    const outageGone = await waitFor(async () => (await rowFor(dbA, outageId)) === null, 3_000, "REDIS row deleted");
    check(outageGone, "REDIS-6 row deleted after recovery delivery");
    await stopEventOutboxRelay();

    // ---------------------------------------------------------
    // MULTI-INSTANCE claim race (two relay instances, same DB)
    // ---------------------------------------------------------
    const raceId = randomUUID();
    created.push(raceId);
    await enqueueCommitted(dbA, raceId);
    let pubA = 0;
    let pubB = 0;
    const relayA = new EventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      publish: async (env) => {
        pubA += 1;
        await publishDurableEnvelope(env);
      },
    });
    const relayB = new EventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(drizzle(poolB) as unknown as DrizzleDb),
      publish: async (env) => {
        pubB += 1;
        await publishDurableEnvelope(env);
      },
    });
    await Promise.all([relayA.tick(), relayB.tick()]);
    check(pubA + pubB === 1, `MULTI-1 exactly one instance claimed the row (A=${pubA} B=${pubB})`);
    await waitFor(async () => (await rowFor(dbA, raceId)) === null, 3_000, "MULTI race row deleted");

    // Deliberate replay: crash after publish, before delete -> same event_id.
    const replayId = randomUUID();
    created.push(replayId);
    await enqueueCommitted(dbA, replayId);
    const ackRepo = new AckFailOnceRepository(dbA);
    ackRepo.failOnce = true;
    startEventOutboxRelay({ repo: ackRepo, intervalMs: 25 });
    const replayed = await waitFor(
      async () => deliveredCount(replayId) >= 2,
      6_000,
      "replay delivery (same event_id twice)",
    );
    check(replayed, "MULTI-2 induced replay delivered the SAME event_id more than once");
    const replayRow = await rowFor(dbA, replayId);
    const allSame = delivered.filter((d) => d === replayId).length >= 2 && replayRow !== null
      ? true
      : deliveredCount(replayId) >= 2;
    check(allSame, "MULTI-3 every replay carried the identical persisted event_id");
    await waitFor(async () => (await rowFor(dbA, replayId)) === null, 3_000, "replay row eventually deleted");
    await stopEventOutboxRelay();

    // ---------------------------------------------------------
    // SHUTDOWN: stop awaits in-flight tick, no scheduling after stop
    // ---------------------------------------------------------
    const stopId = randomUUID();
    created.push(stopId);
    await enqueueCommitted(dbA, stopId);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    let publishEntered = false;
    let publishCalls = 0;
    startEventOutboxRelay({
      repo: new DrizzleEventOutboxRepository(dbA),
      publish: async (env) => {
        publishCalls += 1;
        publishEntered = true;
        await gate;
        await publishDurableEnvelope(env);
      },
      intervalMs: 20,
    });
    const entered = await waitFor(async () => publishEntered, 3_000, "in-flight publish entered");
    check(entered, "SHUTDOWN-1 a tick is in flight (publishing)");

    let stopSettled = false;
    const stopping = stopEventOutboxRelay().then(() => {
      stopSettled = true;
    });
    await sleep(70);
    check(!stopSettled, "SHUTDOWN-2 stop awaits the in-flight tick (not resolved while blocked)");

    releaseGate();
    await stopping;
    check(stopSettled, "SHUTDOWN-3 in-flight tick settled and stop completed");

    const callsAtStop = publishCalls;
    await sleep(80);
    check(publishCalls === callsAtStop, "SHUTDOWN-4 no further ticks scheduled after stop");
    const stopGone = await waitFor(async () => (await rowFor(dbA, stopId)) === null, 3_000, "shutdown row deleted");
    check(stopGone, "SHUTDOWN-5 in-flight tick completed its publish+delete before teardown");

    await cleanup(dbA, created);
  } finally {
    await stopEventOutboxRelay();
    try {
      await subscriber.unsubscribe(CHANNEL);
    } catch {
      // ignore
    }
    try {
      await subscriber.quit();
    } catch {
      // ignore
    }
    try {
      await offlineRedis.quit();
    } catch {
      // ignore
    }
    try {
      await getRedis().quit();
    } catch {
      // ignore
    }
    await poolA.end();
    await poolB.end();
  }

  if (failures > 0) {
    console.error(`EVT-RELAY-BOOTSTRAP REAL-INFRA HARNESS FAILED (${failures} check(s))`);
    process.exitCode = 1;
  } else {
    console.log("EVT-RELAY-BOOTSTRAP REAL-INFRA HARNESS: ALL CHECKS PASSED");
  }
}

main().catch((err) => {
  console.error(
    "EVT-RELAY-BOOTSTRAP REAL-INFRA HARNESS ERROR:",
    err instanceof Error ? err.message : err,
  );
  process.exitCode = 1;
});
