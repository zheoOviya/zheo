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

export function createDb(): DrizzleDb {
  if (process.env.NODE_ENV === "test") {
    throw new Error("DB not available in test mode - use Memory repositories");
  }
  const pool = new Pool({ connectionString: config.database.url });
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
