/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// NOTIFICATION-DELIVERY-CONCURRENCY-A2 — REAL-POSTGRES ATOMICITY PROOF
//
// NOT part of the memory-mode unit suite. Connects to a dedicated disposable
// Postgres database, drives the REAL DrizzleNotificationRepository over
// multiple independent connections, and exits non-zero on any failed
// assertion. No SMS/email provider is involved: this proves repository
// atomicity, not delivery.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/notif_delivery_concurrency_run" \
//   HARNESS_EXPECT_DB_PREFIX=notif_delivery_concurrency \
//     pnpm exec tsx apps/api/integration/realPgNotificationDeliveryConcurrency.ts
//
// PROVES (and only claims) against real Postgres:
//   R1 TWO RESERVERS: one PENDING attempts=0 row, two independent
//      connections reserve concurrently — exactly one winner, attempts final 1
//   R2 TWO RETRY RESERVERS: one due PENDING attempts=1 row, two connections —
//      exactly one winner, attempts final 2
//   R3 SENT PRESERVATION: after markSent the row cannot be regressed by a
//      stale markRetryable/markDead carrying the same attempt
//   R4 FAILED PRESERVATION: at the reserved final attempt markDead wins and a
//      late markSent can never resurrect the row
//   R5 MAX BOUNDARY: attempts=4, two concurrent reservations — exactly one
//      reaches 5, the next reservation loses, attempts never exceeds 5
//   R6 TERMINAL RESERVATION: SENT and FAILED rows cannot be reserved
//   R7 STALE ATTEMPT TOKEN: after attempts advances N -> N+1, a mutation
//      carrying N loses
//   R8 MULTI_CONNECTION: distinct PostgreSQL backend PIDs
//
// DOES NOT claim exactly-once: the NOTIFY-3 provider-success/DB-failure crash
// window remains deferred, as does EventBus/outbox duplication (NOTIFY-6).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleNotificationRepository } from "../src/repositories/notificationRepository";

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "notif_delivery_concurrency";
const ISOLATION_MODE = process.env.HARNESS_ISOLATION_MODE ?? "DISPOSABLE_LOCAL_CLUSTER";

if (!DATABASE_URL) {
  console.error("BLOCKED: HARNESS_DATABASE_URL is not set (no safe Postgres available)");
  process.exit(2);
}
const dbUrl: string = DATABASE_URL;

const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];

function check(id: string, ok: boolean, detail?: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` :: ${detail}` : ""}`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const PAST = new Date("2020-01-01T00:00:00.000Z");
// Reservation eligibility guards `next_attempt_at <= now`; rows enqueued a few
// milliseconds earlier are "due". A tiny skew margin avoids client/server clock
// jitter without weakening the attempts/terminal CAS under test.
const due = (): Date => new Date(Date.now() + 1_000);

function makeDb(pool: Pool): DrizzleDb {
  return drizzle(pool) as unknown as DrizzleDb;
}

async function main(): Promise<void> {
  const poolMain = new Pool({ connectionString: dbUrl, max: 8, application_name: "ndcMain" });
  const poolA = new Pool({ connectionString: dbUrl, max: 1, application_name: "ndcA" });
  const poolB = new Pool({ connectionString: dbUrl, max: 1, application_name: "ndcB" });

  const repoMain = new DrizzleNotificationRepository(makeDb(poolMain));
  const repoA = new DrizzleNotificationRepository(makeDb(poolA));
  const repoB = new DrizzleNotificationRepository(makeDb(poolB));

  const userId = randomUUID();
  let seeded = false;

  const mk = () => ({
    user_id: userId,
    channel: "sms" as const,
    to_address: "+9100000002",
    body: `ndc ${TAG}`,
  });

  const read = async (id: string) => (await repoMain.listAll()).find((r) => r.id === id);

  /** Reserve `count` attempts on a fresh row, parking it back in the due queue. */
  async function seedAttempts(count: number): Promise<string> {
    const n = await repoMain.enqueue(mk());
    for (let i = 0; i < count; i += 1) {
      const r = await repoMain.reserveAttempt(n.id, i, due());
      assert(r !== null, `seed reserve ${i} failed`);
      await repoMain.markRetryable(n.id, r!.attempts, "seed", PAST);
    }
    return n.id;
  }

  try {
    // ---------- environment + isolation + independence ----------
    const envRes = await poolMain.query<{ version: string; db: string; user: string }>(
      "select version() as version, current_database() as db, current_user as user",
    );
    const version = envRes.rows[0]!.version;
    const dbName = envRes.rows[0]!.db;
    const dbUser = envRes.rows[0]!.user;
    const postgresConfirmed = /PostgreSQL/i.test(version);
    const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

    console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
    console.log(`ISOLATION_MODE=${ISOLATION_MODE}`);
    console.log(`RUN_TAG=${TAG}`);
    console.log(`DATABASE_NAME=${dbName}`);
    console.log(`DATABASE_USER=${dbUser}`);
    console.log(`POSTGRES_VERSION=${version.split(" ").slice(0, 2).join(" ")}`);
    check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
    check(
      "P0_ISOLATION_GUARD",
      isolationOk,
      `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`,
    );
    if (!postgresConfirmed || !isolationOk) {
      console.log("HARNESS_RESULT: FAIL");
      return;
    }

    const pidA = (await poolA.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
      .pid;
    const pidB = (await poolB.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
      .pid;
    console.log(`CONN_A_PID=${pidA} CONN_B_PID=${pidB}`);

    // Seed the FK user once.
    await poolMain.query("INSERT INTO users (id, phone) VALUES ($1, $2)", [
      userId,
      `ndc-${TAG}`,
    ]);
    seeded = true;

    // ---------- R1: two reservers, same PENDING attempts=0 ----------
    {
      const n = await repoMain.enqueue(mk());
      const [ra, rb] = await Promise.all([
        repoA.reserveAttempt(n.id, 0, due()),
        repoB.reserveAttempt(n.id, 0, due()),
      ]);
      const winners = [ra, rb].filter((r) => r !== null);
      const row = await read(n.id);
      const ok = winners.length === 1 && row!.attempts === 1 && row!.status === "PENDING";
      check(
        "R1_TWO_RESERVERS",
        ok,
        `winners=${winners.length} attempts=${row!.attempts} status=${row!.status}`,
      );
    }

    // ---------- R2: two retry reservers, same due PENDING attempts=1 ----------
    {
      const n = await repoMain.enqueue(mk());
      const first = await repoMain.reserveAttempt(n.id, 0, due());
      assert(first !== null, "R2 seed reservation failed");
      await repoMain.markRetryable(n.id, first!.attempts, "seed", PAST);
      const [ra, rb] = await Promise.all([
        repoA.reserveAttempt(n.id, 1, due()),
        repoB.reserveAttempt(n.id, 1, due()),
      ]);
      const winners = [ra, rb].filter((r) => r !== null);
      const row = await read(n.id);
      const ok = winners.length === 1 && row!.attempts === 2;
      check(
        "R2_TWO_RETRY_RESERVERS",
        ok,
        `winners=${winners.length} attempts=${row!.attempts}`,
      );
    }

    // ---------- R3: SENT preservation ----------
    {
      const n = await repoMain.enqueue(mk());
      const r1 = await repoA.reserveAttempt(n.id, 0, due());
      assert(r1 !== null, "R3 reservation failed");
      const sent = await repoA.markSent(n.id, r1!.attempts);
      assert(sent !== null, "R3 markSent failed");
      const staleRetry = await repoB.markRetryable(n.id, r1!.attempts, "stale", PAST);
      const staleDead = await repoB.markDead(n.id, r1!.attempts, "stale");
      const row = await read(n.id);
      const ok =
        staleRetry === null &&
        staleDead === null &&
        row!.status === "SENT" &&
        row!.attempts === 1;
      check(
        "R3_SENT_PRESERVATION",
        ok,
        `retry=${staleRetry === null} dead=${staleDead === null} status=${row!.status} attempts=${row!.attempts}`,
      );
    }

    // ---------- R4: FAILED preservation at the reserved final attempt ----------
    {
      const id = await seedAttempts(4);
      const fifth = await repoA.reserveAttempt(id, 4, due());
      assert(fifth !== null && fifth!.attempts === 5, "R4 final reservation failed");
      const dead = await repoA.markDead(id, fifth!.attempts, "final");
      assert(dead !== null, "R4 markDead failed");
      const lateSent = await repoB.markSent(id, fifth!.attempts);
      const lateRetry = await repoB.markRetryable(id, fifth!.attempts, "late", PAST);
      const row = await read(id);
      const ok =
        lateSent === null &&
        lateRetry === null &&
        row!.status === "FAILED" &&
        row!.attempts === 5;
      check(
        "R4_FAILED_PRESERVATION",
        ok,
        `lateSent=${lateSent === null} status=${row!.status} attempts=${row!.attempts}`,
      );
    }

    // ---------- R5: max boundary ----------
    {
      const id = await seedAttempts(4);
      const [ra, rb] = await Promise.all([
        repoA.reserveAttempt(id, 4, due()),
        repoB.reserveAttempt(id, 4, due()),
      ]);
      const winners = [ra, rb].filter((r) => r !== null);
      const afterRace = await read(id);
      const sixth = await repoMain.reserveAttempt(id, 5, due());
      const finalRow = await read(id);
      const ok =
        winners.length === 1 &&
        afterRace!.attempts === 5 &&
        sixth === null &&
        finalRow!.attempts === 5;
      check(
        "R5_MAX_BOUNDARY",
        ok,
        `winners=${winners.length} attempts=${finalRow!.attempts} sixth=${sixth === null}`,
      );
    }

    // ---------- R6: terminal rows cannot reserve ----------
    {
      const sentId = await seedAttempts(1);
      const s = await repoMain.reserveAttempt(sentId, 1, due());
      assert(s !== null, "R6 sent reservation failed");
      await repoMain.markSent(sentId, s!.attempts);

      const failedId = await seedAttempts(4);
      const f = await repoMain.reserveAttempt(failedId, 4, due());
      assert(f !== null, "R6 failed reservation failed");
      await repoMain.markDead(failedId, f!.attempts, "dead");

      const sentReserve = await repoB.reserveAttempt(sentId, 1, due());
      const failedReserve = await repoB.reserveAttempt(failedId, 5, due());
      const ok = sentReserve === null && failedReserve === null;
      check(
        "R6_TERMINAL_RESERVATION",
        ok,
        `sentReserve=${sentReserve === null} failedReserve=${failedReserve === null}`,
      );
    }

    // ---------- R7: stale attempt token loses ----------
    {
      const n = await repoMain.enqueue(mk());
      const r1 = await repoMain.reserveAttempt(n.id, 0, due());
      const r2 = await repoMain.reserveAttempt(n.id, 1, due());
      assert(r1 !== null && r2 !== null, "R7 reservations failed");
      const staleSent = await repoB.markSent(n.id, r1!.attempts);
      const staleRetry = await repoB.markRetryable(n.id, r1!.attempts, "stale", PAST);
      const mid = await read(n.id);
      const freshSent = await repoMain.markSent(n.id, r2!.attempts);
      const end = await read(n.id);
      const ok =
        staleSent === null &&
        staleRetry === null &&
        mid!.status === "PENDING" &&
        mid!.attempts === 2 &&
        freshSent !== null &&
        end!.status === "SENT";
      check(
        "R7_STALE_ATTEMPT_TOKEN",
        ok,
        `staleSent=${staleSent === null} midAttempts=${mid!.attempts} end=${end!.status}`,
      );
    }

    // ---------- R8: multi-connection independence ----------
    check("R8_MULTI_CONNECTION", pidA !== pidB, `pidA=${pidA} pidB=${pidB}`);
  } finally {
    // Deterministic cleanup of harness-owned disposable rows.
    try {
      if (seeded) {
        await poolMain.query("DELETE FROM notifications WHERE user_id = $1", [userId]);
        await poolMain.query("DELETE FROM users WHERE id = $1", [userId]);
      }
      console.log("CLEANUP ok (harness rows removed)");
    } catch (err) {
      console.log(`CLEANUP warning: ${err instanceof Error ? err.message : String(err)}`);
    }
    await poolA.end();
    await poolB.end();
    await poolMain.end();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`CHECKS total=${checks.length} failed=${failed.length}`);
  console.log(`HARNESS_RESULT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  if (failed.length > 0) {
    console.error(`FAILED CHECKS: ${failed.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("NOTIFICATION DELIVERY CONCURRENCY HARNESS FAILED:");
  console.error(err);
  process.exit(1);
});
