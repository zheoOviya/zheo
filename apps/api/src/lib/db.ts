import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config";
import type { DrizzleDb } from "./dbType";

// ============================================
// PostgreSQL + Drizzle ORM connection factory.
// The pool is reused across requests; Drizzle
// provides the typed query builder.
// ============================================

let db: DrizzleDb | null = null;
let pool: Pool | null = null;

export function createDb(): DrizzleDb {
  const realInfra = process.env.TEST_REAL_INFRA === "true";
  if (process.env.NODE_ENV === "test" && !realInfra) {
    throw new Error("DB not available in test mode - use Memory repositories");
  }
  if (realInfra && !process.env.DATABASE_URL?.trim()) {
    // Real infra explicitly demanded but not configured: fail loud instead
    // of silently degrading to the in-memory repositories. The DATABASE_URL
    // config default must NOT satisfy this requirement, so the env var is
    // checked directly.
    throw new Error("TEST_REAL_INFRA requires DATABASE_URL to be set");
  }
  pool = new Pool({ connectionString: config.database.url });
  return drizzle(pool) as unknown as DrizzleDb;
}

export function getDb(): DrizzleDb {
  if (!db) {
    try {
      db = createDb();
    } catch {
      throw new Error("PostgreSQL connection failed");
    }
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/**
 * Probes whether PostgreSQL is actually reachable before the app boots.
 * Pool construction is lazy (it never opens a socket), so `createDb()`
 * succeeding does not mean queries will work. This probe issues a real
 * `SELECT 1` so the caller can fall back to in-memory repositories when
 * the database is down (e.g. in preview environments without Postgres).
 */
export async function probePostgres(timeoutMs = 2000): Promise<boolean> {
  const probe = new Pool({
    connectionString: config.database.url,
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}
