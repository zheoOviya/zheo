// ============================================================
// I2.1 — Real PostgreSQL FOR UPDATE blocking proof harness (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgLockProof.ts
//
// Proves (and only claims):
//   - the ACTUAL Drizzle Dine-In repository lock methods execute physical
//     PostgreSQL SELECT ... FOR UPDATE row locks
//   - a second independent backend blocks on the same row until the first
//     transaction commits
//   - table lock (restaurantTables.lockByToken) and session lock
//     (diningSessions.lockById) both physically block a second backend
//
// Does NOT claim: service interleaving safety (placeOrder x requestBill etc.),
// deadlock-freedom, rollback semantics, MVCC race correctness (I3+).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import {
  DrizzleDiningSessionRepository,
  DrizzleRestaurantTableRepository,
} from "../src/repositories/drizzle/dineInRepositories";

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

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

async function waitForFlag(flag: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (flag()) return;
    await sleep(5);
  }
  throw new Error(`${label} timed out after ${ms}ms`);
}

/** Single short event-loop checkpoint: has the promise settled (resolved or rejected)? */
async function isSettled<T>(p: Promise<T>): Promise<boolean> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await sleep(75);
  return settled;
}

interface ActivityRow {
  wait_event_type: string | null;
  wait_event: string | null;
  state: string | null;
}

/** Poll pg_stat_activity until the backend shows wait_event_type='Lock' (deterministic gate). */
async function waitUntilBlocked(
  pool: Pool,
  pid: number,
  timeoutMs: number,
): Promise<ActivityRow> {
  const deadline = Date.now() + timeoutMs;
  let last: ActivityRow = { wait_event_type: null, wait_event: null, state: null };
  while (Date.now() < deadline) {
    const rows = (await pool.query(
      `SELECT wait_event_type, wait_event, state
         FROM pg_stat_activity
        WHERE pid = $1 AND datname = current_database()`,
      [pid],
    )).rows as ActivityRow[];
    const row = rows[0];
    last = row ?? { wait_event_type: null, wait_event: null, state: null };
    if (last.wait_event_type === "Lock") return last;
    await sleep(20);
  }
  return last;
}

interface LockRow {
  pid: number;
  locktype: string;
  mode: string;
  granted: boolean;
}

async function observeLocks(pool: Pool, aPid: number, bPid: number): Promise<LockRow[]> {
  const rows = (await pool.query(
    `SELECT pid, locktype, mode, granted
       FROM pg_locks
      WHERE pid IN ($1, $2)
        AND locktype IN ('relation', 'tuple', 'transactionid')
      ORDER BY pid, locktype, mode`,
    [aPid, bPid],
  )).rows as LockRow[];
  return rows;
}

async function countIdleInTransaction(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT count(*)::int AS c FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  )).rows as { c: number }[];
  return rows[0]?.c ?? -1;
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  const poolA = new Pool({ connectionString: url });
  const poolB = new Pool({ connectionString: url });
  const poolC = new Pool({ connectionString: url });

  let clientA: import("pg").PoolClient | null = null;
  let clientB: import("pg").PoolClient | null = null;

  const ownerUserId = randomUUID();
  const userId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const tableToken = `itrack-lock-${randomUUID().replace(/-/g, "")}`;
  const label = `I2.1-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;

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

    // ---- minimal Dine-In fixture (no domain services) ----
    const setup = drizzle(poolC);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${userId}, ${`itrack-user-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I2.1-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai})
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
      VALUES (${tableId}, ${restaurantId}, ${label}, ${tableToken})
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id)
      VALUES (${sessionId}, ${restaurantId}, ${tableId}, ${userId})
    `);
    console.log("FIXTURE OK: users(2) + restaurant + table + session inserted");

    // ---- two genuinely independent backends ----
    clientA = await poolA.connect();
    clientB = await poolB.connect();
    await clientA.query("BEGIN");
    await clientB.query("BEGIN");
    const dbA = drizzle(clientA) as unknown as DrizzleDb;
    const dbB = drizzle(clientB) as unknown as DrizzleDb;
    const aPid = (await clientA.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const bPid = (await clientB.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    if (aPid === bPid) throw new Error(`INDEPENDENCE FAILED: same backend pid ${aPid}`);
    console.log(`TWO-CONNECTION OK: connA pid=${aPid}  connB pid=${bPid} (${aPid} != ${bPid})`);

    // ============================================================
    // TABLE LOCK PROOF — restaurantTables.lockByToken
    // ============================================================
    const tableRepoA = new DrizzleRestaurantTableRepository(dbA);
    const tableRepoB = new DrizzleRestaurantTableRepository(dbB);

    let resolveRelease: (() => void) | undefined;
    const release = new Promise<void>((r) => {
      resolveRelease = r;
    });
    let aHoldsTableLock = false;

    const aTableLock = (async () => {
      const row = await tableRepoA.lockByToken(tableToken);
      aHoldsTableLock = true;
      console.log(`[A] table lock acquired (table_id=${row?.id})`);
      await release;
      return row;
    })();
    await withTimeout(
      waitForFlag(() => aHoldsTableLock, 5000, "A never acquired table lock"),
      6000,
      "A table lock acquire wait",
    );

    const bTableLock = tableRepoB.lockByToken(tableToken);

    const blockedT = await waitUntilBlocked(poolC, bPid, 5000);
    console.log(
      `[C] connB backend blocked: wait_event_type=${blockedT.wait_event_type} wait_event=${blockedT.wait_event} state=${blockedT.state}`,
    );

    const bSettledT = await isSettled(bTableLock);
    if (bSettledT) {
      throw new Error("TABLE BLOCKING FAILED: B settled (resolved or errored) while A still held the row lock");
    }
    console.log("TABLE BLOCKING: B pending while A holds (not resolved, no error)");

    const locksT = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while B blocked (table): ${JSON.stringify(locksT)}`);

    resolveRelease?.();
    const aRow = await withTimeout(aTableLock, 5000, "A table lock resolution");
    await clientA.query("COMMIT");
    console.log("[A] committed; table row lock released");

    const bRow = await withTimeout(bTableLock, 5000, "B table lock after A release");
    if (!bRow) throw new Error("TABLE BLOCKING FAILED: B resolved with no row");
    console.log(`[B] table lock resolved after A release (table_id=${bRow.id})`);
    await clientB.query("COMMIT");
    console.log("TABLE LOCK BLOCKING PROOF OK");

    // ============================================================
    // SESSION LOCK PROOF — diningSessions.lockById
    // ============================================================
    await clientA.query("BEGIN");
    await clientB.query("BEGIN");
    const sessionRepoA = new DrizzleDiningSessionRepository(
      drizzle(clientA) as unknown as DrizzleDb,
    );
    const sessionRepoB = new DrizzleDiningSessionRepository(
      drizzle(clientB) as unknown as DrizzleDb,
    );

    let resolveRelease2: (() => void) | undefined;
    const release2 = new Promise<void>((r) => {
      resolveRelease2 = r;
    });
    let aHoldsSessionLock = false;

    const aSessionLock = (async () => {
      const row = await sessionRepoA.lockById(sessionId);
      aHoldsSessionLock = true;
      console.log(`[A] session lock acquired (session_id=${row?.id})`);
      await release2;
      return row;
    })();
    await withTimeout(
      waitForFlag(() => aHoldsSessionLock, 5000, "A never acquired session lock"),
      6000,
      "A session lock acquire wait",
    );

    const bSessionLock = sessionRepoB.lockById(sessionId);

    const blockedS = await waitUntilBlocked(poolC, bPid, 5000);
    console.log(
      `[C] connB backend blocked (session): wait_event_type=${blockedS.wait_event_type} wait_event=${blockedS.wait_event} state=${blockedS.state}`,
    );

    const bSettledS = await isSettled(bSessionLock);
    if (bSettledS) {
      throw new Error("SESSION BLOCKING FAILED: B settled while A still held the session row lock");
    }
    console.log("SESSION BLOCKING: B pending while A holds (not resolved, no error)");

    const locksS = await observeLocks(poolC, aPid, bPid);
    console.log(`pg_locks while B blocked (session): ${JSON.stringify(locksS)}`);

    resolveRelease2?.();
    const aSessionRow = await withTimeout(aSessionLock, 5000, "A session lock resolution");
    await clientA.query("COMMIT");
    console.log("[A] committed; session row lock released");

    const bSessionRow = await withTimeout(bSessionLock, 5000, "B session lock after A release");
    if (!bSessionRow) throw new Error("SESSION BLOCKING FAILED: B resolved with no row");
    console.log(`[B] session lock resolved after A release (session_id=${bSessionRow.id})`);
    await clientB.query("COMMIT");
    console.log("SESSION LOCK BLOCKING PROOF OK");

    const idle = await countIdleInTransaction(poolC);
    console.log(`IDLE-IN-TRANSACTION: ${idle} (expect 0)`);
    if (idle !== 0) throw new Error(`CLEANUP FAILED: ${idle} idle-in-transaction sessions left`);
  } catch (err) {
    console.error("I2.1 PROOF FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    if (clientB) {
      try {
        await clientB.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      clientB.release();
    }
    if (clientA) {
      try {
        await clientA.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      clientA.release();
    }

    // fixture cleanup (FK-safe order) via a fresh connection
    const cleanupPool = new Pool({ connectionString: url });
    try {
      await cleanupPool.query("DELETE FROM dining_sessions WHERE id = $1", [sessionId]);
      await cleanupPool.query("DELETE FROM restaurant_tables WHERE id = $1", [tableId]);
      await cleanupPool.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
      await cleanupPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        [ownerUserId, userId],
      ]);
      console.log("FIXTURE CLEANUP OK");
      const idleFinal = await countIdleInTransaction(cleanupPool);
      console.log(`IDLE-IN-TRANSACTION (final): ${idleFinal} (expect 0)`);
    } catch (e) {
      console.error("FIXTURE CLEANUP WARNING:", e instanceof Error ? e.message : e);
    }
    await cleanupPool.end();
    await poolA.end();
    await poolB.end();
    await poolC.end();
  }
}

main();
