// ============================================================
// UI1-A-R2 — TABLE RESOLUTION REPOSITORY READ MODEL (real PG).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgTableResolve.ts
//
// PROVES (and only claims) the repository-layer public read model
// DrizzleRestaurantTableRepository.resolveByToken against real PG:
//   - eligible token  -> exact trusted read model (restaurant id/name,
//                        table id/label, can_start_session true); opaque
//                        token NOT present anywhere in the DTO.
//   - unknown token   -> null
//   - disabled table  -> null
//   - inactive restaurant -> null   (unknown/disabled/ineligible COLLAPSE
//                        to the same not-found representation)
//   - READ-ONLY: no FOR UPDATE, no transaction, no mutation (no session /
//                        bill / service request is created; no row changes).
//   - no idle-in-transaction left behind.
//
// BOUNDARIES: repository layer only. NO service method, NO route, NO consumer
// UI, NO schema/migration, NO auth/security/CI changes. No commit.
// Security Task 8+ HOLD. STOP after this proof.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleRestaurantTableRepository } from "../src/repositories/drizzle/dineInRepositories";
import type { TableResolveDTO } from "../src/repositories/dineInContracts";

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

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ASSERT OK [${label}]: ${JSON.stringify(actual)}`);
}

function assertNum(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${expected}, got ${actual}`);
  }
  console.log(`  ASSERT OK [${label}]: ${actual}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAIL [${label}]`);
  console.log(`  ASSERT OK [${label}]: true`);
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

  const pool = new Pool({ connectionString: url, application_name: "itrackR2" });

  const ownerUserId = randomUUID();
  const restaurantActiveId = randomUUID();
  const tableActiveId = randomUUID();
  const tableDisabledId = randomUUID();
  const restaurantInactiveId = randomUUID();
  const tableInactiveRestaurantId = randomUUID();
  const restaurantNameActive = `R2-Active-${randomUUID().slice(0, 8)}`;
  const tokenEligible = `R2-eligible-${randomUUID().replace(/-/g, "")}`;
  const tokenDisabled = `R2-disabled-${randomUUID().replace(/-/g, "")}`;
  const tokenInactiveRest = `R2-inactive-rest-${randomUUID().replace(/-/g, "")}`;
  const tokenUnknown = `R2-unknown-${randomUUID().replace(/-/g, "")}`;

  const idleBefore = await countIdleInTransaction(pool);
  console.log(`IDLE-IN-TRANSACTION (before): ${idleBefore} (expect 0)`);
  assertNum(idleBefore, 0, "idle-in-transaction before (expect 0)");

  try {
    const safety = (await pool.query(
      "SELECT current_database() AS db, current_user AS usr",
    )).rows[0] as { db: string; usr: string };
    if (safety.db !== "dine_itrack" || safety.usr !== "dine_itrack") {
      throw new Error(
        `SAFETY REFUSED: expected dine_itrack/dine_itrack, got ${safety.db}/${safety.usr}.`,
      );
    }
    console.log(`SAFETY OK: ${safety.db}/${safety.usr}`);

    const setup = drizzle(pool);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-r2-owner-${randomUUID()}`})`,
    );
    // Active restaurant + active table (eligible).
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantActiveId}, ${ownerUserId}, ${restaurantNameActive}, ${`GSTR2${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAIR2${randomUUID().replace(/-/g, "").slice(0, 10)}`}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableActiveId}, ${restaurantActiveId}, ${"R2-Table-A"}, ${tokenEligible}, true)
    `);
    // Active restaurant + DISABLED table.
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableDisabledId}, ${restaurantActiveId}, ${"R2-Table-D"}, ${tokenDisabled}, false)
    `);
    // INACTIVE restaurant + active table.
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantInactiveId}, ${ownerUserId}, ${`R2-Inactive-${randomUUID().slice(0, 8)}`}, ${`GSTR2i${randomUUID().replace(/-/g, "").slice(0, 10)}`}, ${`FSSAIR2i${randomUUID().replace(/-/g, "").slice(0, 10)}`}, false)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token, is_active)
      VALUES (${tableInactiveRestaurantId}, ${restaurantInactiveId}, ${"R2-Table-I"}, ${tokenInactiveRest}, true)
    `);
    console.log("FIXTURE OK: 1 eligible table + 1 disabled table + 1 inactive-restaurant table");

    const repo = new DrizzleRestaurantTableRepository(setup as unknown as DrizzleDb);

    // ---- eligible token -> exact trusted read model ----
    const resolved: TableResolveDTO | null = await repo.resolveByToken(tokenEligible);
    assertTrue(resolved !== null, "eligible token resolves (non-null)");
    if (!resolved) throw new Error("UI1-A-R2: eligible token unexpectedly null");
    assertEqual(resolved.restaurant.id, restaurantActiveId, "resolved restaurant id");
    assertEqual(resolved.restaurant.name, restaurantNameActive, "resolved restaurant name");
    assertEqual(resolved.table.id, tableActiveId, "resolved table id");
    assertEqual(resolved.table.label, "R2-Table-A", "resolved table label");
    assertEqual(resolved.can_start_session, true, "resolved can_start_session true");
    const serialized = JSON.stringify(resolved);
    assertTrue(!serialized.includes(tokenEligible), "opaque token NOT present anywhere in DTO");
    assertEqual(
      JSON.stringify(Object.keys(resolved).sort()),
      JSON.stringify(["can_start_session", "restaurant", "table"].sort()),
      "DTO has ONLY {restaurant, table, can_start_session} keys (no internal metadata)",
    );
    assertEqual(
      JSON.stringify(Object.keys(resolved.restaurant).sort()),
      JSON.stringify(["id", "name"].sort()),
      "restaurant exposes ONLY id+name",
    );
    assertEqual(
      JSON.stringify(Object.keys(resolved.table).sort()),
      JSON.stringify(["id", "label"].sort()),
      "table exposes ONLY id+label",
    );
    console.log(`RESOLVE OK (eligible): ${JSON.stringify(resolved)}`);

    // ---- unknown / disabled / inactive-restaurant -> same null collapse ----
    assertEqual(await repo.resolveByToken(tokenUnknown), null, "unknown token -> null");
    assertEqual(await repo.resolveByToken(tokenDisabled), null, "disabled table -> null");
    assertEqual(
      await repo.resolveByToken(tokenInactiveRest),
      null,
      "inactive restaurant -> null (collapse, no leak of which state)",
    );
    console.log("NOT-FOUND COLLAPSE OK: unknown / disabled / inactive all -> null");

    // ---- READ-ONLY / no mutation proof ----
    const sessionCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM dining_sessions WHERE restaurant_id IN (${restaurantActiveId}, ${restaurantInactiveId})`,
    )).rows[0]?.c as number;
    const billCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills`,
    )).rows[0]?.c as number;
    const requestCount = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM service_requests`,
    )).rows[0]?.c as number;
    const tableStillActive = (await setup.execute(
      sql`SELECT is_active FROM restaurant_tables WHERE id = ${tableActiveId}`,
    )).rows[0] as { is_active: boolean } | undefined;
    assertNum(sessionCount, 0, "no mutation: 0 dining_sessions created");
    assertNum(billCount, 0, "no mutation: 0 session_bills");
    assertNum(requestCount, 0, "no mutation: 0 service_requests");
    assertEqual(tableStillActive?.is_active, true, "no mutation: table row unchanged (is_active true)");
    console.log("READ-ONLY OK: resolve created no session/bill/request and changed no rows");

    // ---- cleanup ----
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE restaurant_id IN (${restaurantActiveId}, ${restaurantInactiveId})`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id IN (${restaurantActiveId}, ${restaurantInactiveId})`);
    await setup.execute(sql`DELETE FROM users WHERE id = ${ownerUserId}`);
    console.log("FIXTURE CLEANUP OK");

    const idleFinal = await countIdleInTransaction(pool);
    assertNum(idleFinal, 0, "idle-in-transaction final (expect 0)");
    const tables = (await pool.query(
      "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    )).rows[0] as { c: number };
    const migrations = (await pool.query(
      `SELECT count(*)::int AS c FROM drizzle."__drizzle_migrations"`,
    )).rows[0] as { c: number };
    assertNum(tables.c, 23, "public tables (expect 23)");
    assertNum(migrations.c, 15, "migration rows (expect 15)");

    console.log("UI1-A-R2 TABLE RESOLUTION REPOSITORY READ MODEL PROOF OK");
  } finally {
    for (const p of [pool]) {
      p.end().catch(() => {});
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
