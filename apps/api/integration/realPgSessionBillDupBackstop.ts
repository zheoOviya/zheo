// ============================================================
// I7.2-E — SESSIONBILL DIRECT DB UNIQUE BACKSTOP.
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV with an explicit disposable DATABASE_URL:
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://dine_itrack:<pw>@127.0.0.1:5432/dine_itrack \
//   pnpm exec tsx apps/api/integration/realPgSessionBillDupBackstop.ts
//
// PROVES (and only claims) the PHYSICAL DB backstop for the
// "exactly one SessionBill per session" invariant:
//   - minimum valid session fixture + exactly ONE legitimate
//     SessionBill (created via the real DrizzleSessionBillRepository);
//   - a SECOND SessionBill with the SAME session_id, inserted via
//     direct SQL inside a SEPARATE transaction, is rejected by the
//     PostgreSQL UNIQUE index session_bills_session_idx with
//     SQLSTATE 23505 / constraint session_bills_session_idx;
//   - after the failed transaction rolls back, fresh reads still show
//     exactly 1 SessionBill with the ORIGINAL id and values unchanged.
//
// BOUNDARIES:
//   - NO concurrent requestBill, NO service race, NO requestBill call.
//   - NO BRING_BILL insert or test. BRING_BILL has NO physical
//     uniqueness constraint; its duplicate prevention was proven at the
//     service/session-lock layer in I7.2-D (lock-serialized resume).
//   - NO production code, schema/migration, auth/security/CI changes;
//     no commit. Security Task 8+ HOLD. STOP after this proof.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DrizzleDb } from "../src/lib/dbType";
import { DrizzleSessionBillRepository } from "../src/repositories/drizzle/dineInRepositories";

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

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

function isPgError(e: unknown): e is PgErrorLike {
  return typeof e === "object" && e !== null;
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

  const pool = new Pool({ connectionString: url, application_name: "itrackEC" });
  const poolDup = new Pool({ connectionString: url, max: 1, application_name: "itrackED" });

  const ownerUserId = randomUUID();
  const restaurantId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  const tableToken = `itrack-ir-${randomUUID().replace(/-/g, "")}`;
  const label = `I7.2E-${randomUUID().slice(0, 8)}`;
  const gst = `GST${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const fssai = `FSSAI${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const idleBefore = await countIdleInTransaction(pool);
  console.log(`IDLE-IN-TRANSACTION (before): ${idleBefore} (expect 0)`);
  assertNum(idleBefore, 0, "idle-in-transaction before (expect 0)");

  try {
    // ---- database safety gate ----
    const safety = (await pool.query(
      "SELECT current_database() AS db, current_user AS usr",
    )).rows[0] as { db: string; usr: string };
    if (safety.db !== "dine_itrack" || safety.usr !== "dine_itrack") {
      throw new Error(
        `SAFETY REFUSED: expected dine_itrack/dine_itrack, got ${safety.db}/${safety.usr}. Refusing shared/fallback DB.`,
      );
    }
    console.log(`SAFETY OK: ${safety.db}/${safety.usr}`);

    // ---- physical index existence (supporting evidence) ----
    const idx = (await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'session_bills'
          AND indexname = 'session_bills_session_idx'`,
    )).rows[0] as { indexname: string; indexdef: string } | undefined;
    assertTrue(!!idx, "index session_bills_session_idx exists");
    assertTrue(idx!.indexdef.toUpperCase().includes("UNIQUE"), `index is UNIQUE: ${idx!.indexdef}`);
    console.log(`INDEX CONFIRMED: ${idx!.indexdef}`);

    // ---- minimum valid session fixture ----
    const setup = drizzle(pool);
    await setup.execute(
      sql`INSERT INTO users (id, phone) VALUES (${ownerUserId}, ${`itrack-owner-${randomUUID()}`})`,
    );
    await setup.execute(sql`
      INSERT INTO restaurants (id, owner_id, name, gst_number, fssai_license, is_active)
      VALUES (${restaurantId}, ${ownerUserId}, ${`I7.2E-Restaurant-${randomUUID().slice(0, 8)}`}, ${gst}, ${fssai}, true)
    `);
    await setup.execute(sql`
      INSERT INTO restaurant_tables (id, restaurant_id, label, table_token)
      VALUES (${tableId}, ${restaurantId}, ${label}, ${tableToken})
    `);
    await setup.execute(sql`
      INSERT INTO dining_sessions (id, restaurant_id, table_id, owner_user_id, status)
      VALUES (${sessionId}, ${restaurantId}, ${tableId}, ${ownerUserId}, 'ACTIVE')
    `);

    // ---- exactly ONE legitimate SessionBill via the REAL repository ----
    const foodSubtotal = 199.0;
    const gstFood = round2(foodSubtotal * 0.05);
    const billTotal = round2(foodSubtotal + gstFood);
    const billRepo = new DrizzleSessionBillRepository(setup as unknown as DrizzleDb);
    const original = await billRepo.createFrozenBill({
      session_id: sessionId,
      restaurant_id: restaurantId,
      food_subtotal: foodSubtotal,
      packaging_fee: 0,
      gst_food: gstFood,
      gst_packaging: 0,
      total_amount: billTotal,
    });
    const originalId = original.id;
    assertNum(billTotal, round2(foodSubtotal + gstFood), "bill arithmetic consistent");
    console.log(`FIXTURE OK: ACTIVE session + exactly 1 legitimate SessionBill (id=${originalId}, total=${billTotal.toFixed(2)})`);

    const billCount1 = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertNum(billCount1, 1, "fresh read: SessionBill count = 1");

    // ---- duplicate insert attempt: SEPARATE transaction, direct SQL,
    // same session_id, DIFFERENT id + amounts (proves uniqueness on the
    // session, not row-identical dedup) ----
    const dupId = randomUUID();
    const dupFood = 50.0;
    const dupGst = round2(dupFood * 0.05);
    const dupTotal = round2(dupFood + dupGst);
    await poolDup.query("BEGIN");
    let caught: PgErrorLike | null = null;
    try {
      await poolDup.query(
        `INSERT INTO session_bills
          (id, session_id, restaurant_id, food_subtotal, packaging_fee, gst_food, gst_packaging, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dupId, sessionId, restaurantId, dupFood.toFixed(2), "0.00", dupGst.toFixed(2), "0.00", dupTotal.toFixed(2)],
      );
      console.error("FATAL: duplicate insert unexpectedly succeeded");
      await poolDup.query("ROLLBACK");
      process.exit(1);
    } catch (e) {
      caught = isPgError(e) ? e : null;
      await poolDup.query("ROLLBACK");
    }
    assertTrue(caught !== null, "duplicate insert rejected with a PostgreSQL error");
    assertEqual(caught?.code, "23505", "SQLSTATE = 23505 (unique_violation)");
    assertEqual(caught?.constraint, "session_bills_session_idx", "constraint/index = session_bills_session_idx");
    console.log(`DUPLICATE INSERT ATTEMPT REJECTED: code=${caught?.code} constraint=${caught?.constraint}`);
    console.log("NOTE: the error is the UNIQUE index violation, not an unrelated FK/CHECK violation.");

    // ---- post-failure cardinality: fresh independent read after rollback ----
    const billCount2 = (await setup.execute(
      sql`SELECT count(*)::int AS c FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0]?.c as number;
    assertNum(billCount2, 1, "post-failure: SessionBill count = exactly 1");
    const post = (await setup.execute(
      sql`SELECT id, food_subtotal, packaging_fee, gst_food, gst_packaging, total_amount
            FROM session_bills WHERE session_id = ${sessionId}`,
    )).rows[0] as {
      id: string;
      food_subtotal: string;
      packaging_fee: string;
      gst_food: string;
      gst_packaging: string;
      total_amount: string;
    };
    assertEqual(post.id, originalId, "post-failure: original bill id unchanged");
    assertEqual(Number(post.food_subtotal), foodSubtotal, "post-failure: food_subtotal unchanged");
    assertEqual(Number(post.gst_food), gstFood, "post-failure: gst_food unchanged");
    assertEqual(Number(post.total_amount), billTotal, "post-failure: total_amount unchanged");
    assertTrue(post.id !== dupId, "post-failure: duplicate id absent from committed state");
    console.log("POST-FAILURE CARDINALITY: exactly 1 SessionBill / original id + values unchanged / duplicate id absent");

    // ---- BRING_BILL boundary ----
    console.log("BRING_BILL BOUNDARY: no BRING_BILL insert or test here. BRING_BILL has NO physical uniqueness");
    console.log("constraint; its duplicate prevention was already proven at the service/session-lock layer in I7.2-D.");

    // ---- cleanup ----
    await setup.execute(sql`DELETE FROM session_bills WHERE session_id = ${sessionId}`);
    await setup.execute(sql`DELETE FROM dining_sessions WHERE id = ${sessionId}`);
    await setup.execute(sql`DELETE FROM restaurant_tables WHERE id = ${tableId}`);
    await setup.execute(sql`DELETE FROM restaurants WHERE id = ${restaurantId}`);
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

    console.log("I7.2-E SESSIONBILL DIRECT DB UNIQUE BACKSTOP PROOF OK");
  } finally {
    for (const p of [pool, poolDup]) {
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
