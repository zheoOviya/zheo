// ============================================================
// I2.0 — Ephemeral PostgreSQL bootstrap proof harness (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgBootstrap.ts
//
// Proves (and only claims):
//   - real PostgreSQL reachable
//   - two genuinely independent DB backends (distinct pg_backend_pid)
//   - Drizzle genuinely talks to PostgreSQL (basic roundtrip)
//
// Does NOT claim: FOR UPDATE blocking, serialization, rollback of
// Dine-In service ops, MVCC races, deadlock behavior (those are I2.1+).
// ============================================================

import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at the disposable I-track DB)");
  process.exit(2);
}

function redacted(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable)";
  }
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);

  // conn A and conn B are two independent pg.Pool instances.
  const poolA = new Pool({ connectionString: url, max: 1 });
  const poolB = new Pool({ connectionString: url, max: 1 });

  const dbA = drizzle(poolA);
  const dbB = drizzle(poolB);

  try {
    const [identA, identB] = await Promise.all([
      dbA.execute(sql`SELECT current_database() AS db, current_user AS usr, pg_backend_pid() AS pid, version() AS v`),
      dbB.execute(sql`SELECT current_database() AS db, current_user AS usr, pg_backend_pid() AS pid, version() AS v`),
    ]);

    const a = identA.rows[0] as { db: string; usr: string; pid: number; v: string };
    const b = identB.rows[0] as { db: string; usr: string; pid: number; v: string };

    console.log("connA ->", { db: a.db, usr: a.usr, pid: a.pid, version: a.v.split(",")[0] });
    console.log("connB ->", { db: b.db, usr: b.usr, pid: b.pid, version: b.v.split(",")[0] });

    if (a.pid === b.pid) {
      throw new Error(`INDEPENDENCE FAILED: conn A and conn B share backend pid ${a.pid}`);
    }
    console.log(`INDEPENDENCE OK: distinct pg_backend_pid (${a.pid} != ${b.pid})`);

    // Basic roundtrip: Drizzle genuinely talks to PostgreSQL via a scratch
    // table, then deterministic cleanup.
    await dbA.execute(sql`CREATE TABLE IF NOT EXISTS itrack_roundtrip (id integer PRIMARY KEY, note text)`);
    await dbA.execute(sql`INSERT INTO itrack_roundtrip (id, note) VALUES (1, 'itrack-probe')`);
    const readBack = (await dbA.execute(sql`SELECT note FROM itrack_roundtrip WHERE id = 1`)).rows[0] as {
      note: string;
    };
    if (readBack.note !== "itrack-probe") {
      throw new Error(`ROUNDTRIP FAILED: unexpected value ${JSON.stringify(readBack)}`);
    }
    console.log(`ROUNDTRIP OK: Drizzle wrote+read '${readBack.note}' through real PostgreSQL`);
    await dbA.execute(sql`DROP TABLE itrack_roundtrip`);
    console.log("ROUNDTRIP CLEANUP OK: scratch table dropped");
  } finally {
    await poolA.end();
    await poolB.end();
  }
}

main().catch((err) => {
  console.error("BOOTSTRAP FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
