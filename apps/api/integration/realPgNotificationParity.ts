// ============================================================
// NOTIFICATION-PG-PARITY-A2 — REAL-POSTGRES DURABILITY + ATOMICITY PROOF
// (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (the
// notifications table + notification_status enum + users FK must exist):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/notif_a2_p4_run \
//   pnpm exec tsx apps/api/integration/realPgNotificationParity.ts
//
// PROVES (and only claims):
//   (1) enqueue writes a notifications row (PENDING / attempts 0 / no error)
//       readable back through the Drizzle repository.
//   (2) markSent / markRetryable / markDead each apply the memory backend's
//       `attempts = attempts + 1` semantics on REAL PostgreSQL, accumulating
//       1 -> 2 -> 3 -> 4 alongside the status/error/backoff columns.
//   (3) the memory and Drizzle backends produce identical observable state
//       for the same transition sequence.
//   (4) the increment is atomic under concurrent writers: N simultaneous
//       markRetryable calls advance attempts by exactly N (no lost updates),
//       which a read-modify-write implementation would fail.
//   (5) all state survives closing the pool and reading through a fresh
//       independent connection (durability across restart).
//
// Memory-parity alone is not a durability proof; this harness talks to the
// real table. Disposable rows are left in the disposable DB by design.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DrizzleNotificationRepository } from "../src/repositories/notificationRepository";
import { MemoryNotificationRepository } from "../src/repositories/notificationRepository";
import type { DrizzleDb } from "../src/lib/dbType";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at a disposable, migrated DB)");
  process.exit(2);
}
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}
const dbUrl: string = url;

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function makeDb(pool: Pool): DrizzleDb {
  return drizzle(pool) as unknown as DrizzleDb;
}

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2999-01-01T00:00:00.000Z");

function input() {
  return {
    user_id: "",
    channel: "sms" as const,
    to_address: "+9100000001",
    body: "a2 parity",
  };
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG notification parity proof starting...");

  const userId = randomUUID();
  const tag = randomUUID().slice(0, 8);

  // Connection epoch 1: seed FK user + write transitions.
  const poolA = new Pool({ connectionString: dbUrl, max: 12 });
  await poolA.query("INSERT INTO users (id, phone) VALUES ($1, $2)", [
    userId,
    `notif-a2-${tag}`,
  ]);
  const repoA = new DrizzleNotificationRepository(makeDb(poolA));

  const mk = () => ({ ...input(), user_id: userId });

  // (1) enqueue defaults.
  const n1 = await repoA.enqueue(mk());
  assert(n1.status === "PENDING", `enqueue status ${n1.status}`);
  assert(n1.attempts === 0, `enqueue attempts ${n1.attempts}`);
  const r1 = (await repoA.listAll()).find((r) => r.id === n1.id)!;
  assert(r1 !== undefined, "enqueue row not readable");
  assert(r1.attempts === 0 && r1.status === "PENDING", "enqueue persisted state wrong");
  assert(r1.last_error === null, "enqueue last_error not null");
  console.log(`[epoch1] enqueue -> PENDING attempts=0`);

  // (2) transitions each increment attempts exactly once.
  await repoA.markSent(n1.id);
  const r2 = (await repoA.listAll()).find((r) => r.id === n1.id)!;
  assert(r2.attempts === 1, `markSent attempts ${r2.attempts} != 1`);
  assert(r2.status === "SENT", `markSent status ${r2.status}`);
  assert(r2.last_error === null, "markSent did not clear last_error");

  await repoA.markRetryable(n1.id, "e1", FUTURE);
  const r3 = (await repoA.listAll()).find((r) => r.id === n1.id)!;
  assert(r3.attempts === 2, `markRetryable#1 attempts ${r3.attempts} != 2`);
  assert(r3.status === "PENDING", `markRetryable#1 status ${r3.status}`);
  assert(r3.last_error === "e1", `markRetryable#1 last_error ${r3.last_error}`);
  assert(
    Math.abs(Date.parse(r3.next_attempt_at) - FUTURE.getTime()) < 1000,
    `markRetryable#1 next_attempt_at ${r3.next_attempt_at}`,
  );

  await repoA.markRetryable(n1.id, "e2", PAST);
  const r4 = (await repoA.listAll()).find((r) => r.id === n1.id)!;
  assert(r4.attempts === 3, `markRetryable#2 attempts ${r4.attempts} != 3`);

  await repoA.markDead(n1.id, "e3");
  const r5 = (await repoA.listAll()).find((r) => r.id === n1.id)!;
  assert(r5.attempts === 4, `markDead attempts ${r5.attempts} != 4`);
  assert(r5.status === "FAILED", `markDead status ${r5.status}`);
  assert(r5.last_error === "e3", `markDead last_error ${r5.last_error}`);
  console.log(`[epoch1] markSent/retry/retry/dead -> attempts=4 FAILED`);

  // (3) memory parity for the same sequence.
  const memory = new MemoryNotificationRepository();
  const m = await memory.enqueue(mk());
  await memory.markSent(m.id);
  await memory.markRetryable(m.id, "e1", FUTURE);
  await memory.markRetryable(m.id, "e2", PAST);
  await memory.markDead(m.id, "e3");
  const memRow = (await memory.listAll())[0]!;
  assert(
    memRow.status === r5.status && memRow.attempts === r5.attempts && memRow.last_error === r5.last_error,
    `memory/PG divergence: mem=${memRow.status}/${memRow.attempts}/${memRow.last_error} pg=${r5.status}/${r5.attempts}/${r5.last_error}`,
  );
  console.log(`[epoch1] memory parity unchanged -> attempts=4 FAILED`);

  // (4) atomic increment under concurrency: N writers, attempts must equal N.
  const concurrent = await repoA.enqueue(mk());
  const writers = 10;
  await Promise.all(
    Array.from({ length: writers }, (_, i) =>
      repoA.markRetryable(concurrent.id, `c${i}`, PAST),
    ),
  );
  const r6 = (await repoA.listAll()).find((r) => r.id === concurrent.id)!;
  assert(
    r6.attempts === writers,
    `concurrent increments lost: attempts=${r6.attempts} expected ${writers}`,
  );
  console.log(`[epoch1] ${writers} concurrent markRetryable -> attempts=${r6.attempts}`);

  // (5) durability across a fresh connection.
  await poolA.end();
  const poolB = new Pool({ connectionString: dbUrl, max: 1 });
  const repoB = new DrizzleNotificationRepository(makeDb(poolB));
  const r7 = (await repoB.listAll()).find((r) => r.id === n1.id)!;
  assert(r7 !== undefined, "row missing after pool restart");
  assert(
    r7.attempts === 4 && r7.status === "FAILED" && r7.last_error === "e3",
    `durability mismatch: ${r7.status}/${r7.attempts}/${r7.last_error}`,
  );
  const r8 = (await repoB.listAll()).find((r) => r.id === concurrent.id)!;
  assert(r8.attempts === writers, `concurrent attempts not durable (${r8.attempts})`);
  await poolB.end();
  console.log(`[epoch2] fresh connection after restart -> attempts=4 FAILED (durable)`);

  console.log("A2 real-PG notification parity proof PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("A2 real-PG notification parity proof FAILED:");
  console.error(err);
  process.exit(1);
});
