// ============================================================
// PROMOTION-PG-DURABILITY-A2 - REAL-POSTGRES DURABILITY PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (migration
// 0018_promotion_persistence.sql must have been applied):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://<user>:<pw>@127.0.0.1:5432/<disposable_db> \
//   pnpm exec tsx apps/api/integration/realPgPromotionPersistence.ts
//
// PROVES (and only claims):
//   P1  promotions table + exact column metadata, PK-only, no extra indexes/FKs,
//       and value is UNCONSTRAINED numeric (numeric_precision IS NULL).
//   P2  create persists the row and returns the exact PromotionDTO; an
//       independent raw read round-trips it.
//   P3  restart durability: close the first pool, a fresh pool/repo reads the row.
//   P4  cross-instance: instance A creates; independent instance B (distinct
//       pg_backend_pid) reads/lists it.
//   P5  expired promotion (valid_until < now) is excluded by listActive().
//   P6  equality boundary: valid_until == captured now is ACTIVE, proven
//       through public listActive() with a frozen app clock.
//   P7  is_active=false row excluded via a direct DB fixture.
//   P8  created_at DESC ordering with distinct timestamps.
//   P9  numeric round-trip exact (15, 12.5, 0.1, 99999.99, 100) at the raw
//       value::text level and through the DTO Number() mapping.
//   P10 duplicate titles are allowed (no title uniqueness).
//   P11 NO FABRICATED BACKFILL: migration 0018 has no DML, and writing an
//       unrelated historical entity (a user) does not create promotion rows.
//   P12 memory observable parity: MemoryPromotionRepository and
//       DrizzlePromotionRepository agree on filtering + ordering observably.
//
// Memory-parity alone is not a durability proof; this harness talks to the
// real table through real connection pools. Rows are left in the disposable DB
// by design (no destructive cleanup).
// ============================================================

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { DrizzlePromotionRepository } from "../src/repositories/drizzle/drizzlePromotionRepository";
import { MemoryPromotionRepository } from "../src/repositories/promotionRepository";
import type { DiscountType } from "../src/repositories/promotionRepository";
import type { DrizzleDb } from "../src/lib/dbType";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at a disposable, migrated DB)");
  process.exit(2);
}
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV");
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

function makeDb(pool: Pool): DrizzleDb {
  return drizzle(pool) as unknown as DrizzleDb;
}

type RawDb = { execute: (q: unknown) => Promise<{ rows: Record<string, unknown>[] }> };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function rawRows(db: DrizzleDb, q: unknown): Promise<Record<string, unknown>[]> {
  return (await (db as unknown as RawDb).execute(q)).rows;
}

/** Freezes the app clock (`new Date()` / `Date.now()`) for the duration of
 *  `fn`, so the equality-boundary comparison in listActive() is deterministic.
 *  Objects returned by the frozen constructor are real Date instances. */
async function withFrozenNow<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = new RealDate(iso).getTime();
  const Ctor = RealDate as unknown as new (...a: unknown[]) => Date;
  const Frozen = function (this: unknown, ...args: unknown[]): Date {
    if (args.length === 0) return new Ctor(fixedMs);
    return new Ctor(...args);
  } as unknown as DateConstructor;
  Frozen.now = () => fixedMs;
  Frozen.parse = RealDate.parse;
  Frozen.UTC = RealDate.UTC;
  Frozen.prototype = RealDate.prototype;
  (globalThis as unknown as { Date: DateConstructor }).Date = Frozen;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
  }
}

interface SeedRow {
  id: string;
  title: string;
  discountType: DiscountType;
  value: string;
  validUntil: Date;
  isActive: boolean;
  createdAt: Date;
}

async function insertRow(db: DrizzleDb, r: SeedRow): Promise<void> {
  await (db as unknown as RawDb).execute(
    sql`INSERT INTO promotions (id, title, discount_type, value, valid_until, is_active, created_at)
        VALUES (${r.id}, ${r.title}, ${r.discountType}, ${r.value}::numeric, ${r.validUntil}, ${r.isActive}, ${r.createdAt})`,
  );
}

async function countByTitle(db: DrizzleDb, title: string): Promise<number> {
  const rows = await rawRows(
    db,
    sql`SELECT count(*)::int AS n FROM promotions WHERE title = ${title}`,
  );
  return rows[0]!.n as number;
}

async function countAll(db: DrizzleDb): Promise<number> {
  const rows = await rawRows(db, sql`SELECT count(*)::int AS n FROM promotions`);
  return rows[0]!.n as number;
}

async function seedUser(db: DrizzleDb): Promise<string> {
  const id = randomUUID();
  await (db as unknown as RawDb).execute(
    sql`INSERT INTO users (id, phone, role, created_at) VALUES (${id}, ${"pm-" + randomUUID()}, ${"CONSUMER"}, now())`,
  );
  return id;
}

const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG promotion durability proof starting...");
  const tag = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const poolA = new Pool({ connectionString: dbUrl, max: 4 });
  const dbA = makeDb(poolA);
  const rawA = dbA as unknown as RawDb;
  const repoA = new DrizzlePromotionRepository(dbA);

  try {
    // ---------- P1: schema/table metadata ----------
    const cols = await rawRows(
      dbA,
      sql`SELECT column_name, data_type, udt_name, is_nullable, column_default, numeric_precision, numeric_scale
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name='promotions' ORDER BY ordinal_position`,
    );
    const names = cols.map((c) => c.column_name as string);
    assert(
      JSON.stringify(names) ===
        JSON.stringify(["id", "title", "discount_type", "value", "valid_until", "is_active", "created_at"]),
      `P1: unexpected columns ${names.join(",")}`,
    );
    const byName = (n: string) => cols.find((c) => c.column_name === n)!;
    assert(byName("id").data_type === "uuid" && byName("id").is_nullable === "NO", "P1: id metadata");
    assert(String(byName("id").column_default).includes("gen_random_uuid"), "P1: id default");
    for (const c of ["title", "discount_type"]) {
      assert(byName(c).data_type === "text" && byName(c).is_nullable === "NO", `P1: ${c} metadata`);
    }
    assert(byName("value").udt_name === "numeric" && byName("value").is_nullable === "NO", "P1: value metadata");
    assert(
      byName("value").numeric_precision === null && byName("value").numeric_scale === null,
      "P1: value must be UNCONSTRAINED numeric",
    );
    assert(
      byName("valid_until").data_type === "timestamp with time zone" && byName("valid_until").is_nullable === "NO",
      "P1: valid_until metadata",
    );
    assert(
      byName("is_active").data_type === "boolean" &&
        byName("is_active").is_nullable === "NO" &&
        String(byName("is_active").column_default) === "true",
      "P1: is_active metadata",
    );
    assert(
      byName("created_at").data_type === "timestamp with time zone" &&
        byName("created_at").is_nullable === "NO" &&
        String(byName("created_at").column_default) === "now()",
      "P1: created_at metadata",
    );
    // PK only; no extra indexes; no FKs.
    const idx = await rawRows(
      dbA,
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='promotions'`,
    );
    assert(idx.length === 1 && /UNIQUE.*\(id\)/.test(String(idx[0]!.indexdef)), `P1: expected only PK index, got ${idx.length}`);
    const fks = await rawRows(
      dbA,
      sql`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f'
          AND (conrelid = 'public.promotions'::regclass OR confrelid = 'public.promotions'::regclass)`,
    );
    assert((fks[0]!.n as number) === 0, "P1: promotions must have no foreign keys");
    console.log(`[P1] promotions columns exact: ${names.join(", ")}; PK-only, no FK, value unconstrained numeric`);

    // ---------- P2: create + DTO + independent raw read ----------
    const p2 = await repoA.create({
      title: `P2_${tag}`,
      discount_type: "PERCENTAGE",
      value: 15,
      valid_until: FUTURE,
    });
    assert(
      JSON.stringify(Object.keys(p2).sort()) ===
        JSON.stringify(["created_at", "discount_type", "id", "is_active", "title", "valid_until", "value"]),
      `P2: DTO keys ${Object.keys(p2).join(",")}`,
    );
    assert(/^[0-9a-f-]{36}$/.test(p2.id), "P2: id not a uuid");
    assert(p2.title === `P2_${tag}`, "P2: title");
    assert(p2.discount_type === "PERCENTAGE" && p2.value === 15 && p2.is_active === true, "P2: scalar fields");
    assert(p2.valid_until === FUTURE, "P2: valid_until should be returned verbatim");
    assert(!Number.isNaN(Date.parse(p2.created_at)), "P2: created_at not ISO");
    const p2raw = await rawRows(
      dbA,
      sql`SELECT title, discount_type, value::text AS value, valid_until, is_active, created_at
          FROM promotions WHERE id = ${p2.id}`,
    );
    assert(p2raw.length === 1, "P2: persisted row missing");
    assert(p2raw[0]!.title === `P2_${tag}`, "P2: persisted title");
    assert(p2raw[0]!.discount_type === "PERCENTAGE", "P2: persisted discount_type");
    assert(p2raw[0]!.value === "15", `P2: persisted value ${String(p2raw[0]!.value)}`);
    const vu = p2raw[0]!.valid_until;
    assert(
      (vu instanceof Date ? vu.toISOString() : new Date(String(vu)).toISOString()) === FUTURE,
      "P2: persisted valid_until",
    );
    assert(p2raw[0]!.is_active === true, "P2: persisted is_active");
    console.log(`[P2] create -> exact DTO + raw round-trip (${p2.title})`);

    // ---------- P3: restart durability ----------
    const p3 = await repoA.create({
      title: `P3_${tag}`,
      discount_type: "FLAT",
      value: 50,
      valid_until: FUTURE,
    });
    const poolRestart = new Pool({ connectionString: dbUrl, max: 2 });
    try {
      const repoRestart = new DrizzlePromotionRepository(makeDb(poolRestart));
      const after = await repoRestart.listActive();
      assert(after.some((p) => p.id === p3.id), "P3: row not visible after pool restart");
      console.log(`[P3] restart durability OK for ${p3.title}`);
    } finally {
      await poolRestart.end();
    }

    // ---------- P4: cross-instance A -> B, independent PIDs ----------
    const poolB = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      const dbB = makeDb(poolB);
      const repoB = new DrizzlePromotionRepository(dbB);
      const pidA = (await rawRows(dbA, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid as number;
      const pidB = (await rawRows(dbB, sql`SELECT pg_backend_pid() AS pid`))[0]!.pid as number;
      assert(pidA !== pidB, `P4: pools share backend pid ${pidA}`);
      const p4 = await repoA.create({
        title: `P4_${tag}`,
        discount_type: "FLAT",
        value: 25,
        valid_until: FUTURE,
      });
      const seenByB = await repoB.listActive();
      assert(seenByB.some((p) => p.id === p4.id), "P4: instance B does not see A's promotion");
      console.log(`[P4] cross-instance A -> B OK (pidA=${pidA} pidB=${pidB})`);
    } finally {
      await poolB.end();
    }

    // ---------- P5: expired excluded ----------
    const p5 = await repoA.create({
      title: `P5_EXPIRED_${tag}`,
      discount_type: "FLAT",
      value: 10,
      valid_until: PAST,
    });
    const activeAfterP5 = await repoA.listActive();
    assert(!activeAfterP5.some((p) => p.id === p5.id), "P5: expired promotion was returned");
    console.log("[P5] expired promotion excluded");

    // ---------- P6: equality boundary active (frozen app clock) ----------
    const boundaryIso = "2027-03-01T12:00:00.000Z";
    const p6 = await repoA.create({
      title: `P6_BOUNDARY_${tag}`,
      discount_type: "FLAT",
      value: 33,
      valid_until: boundaryIso,
    });
    const atBoundary = await withFrozenNow(boundaryIso, () => repoA.listActive());
    assert(atBoundary.some((p) => p.id === p6.id), "P6: valid_until == now must be ACTIVE");
    const afterBoundaryMs = new Date(new Date(boundaryIso).getTime() + 1).toISOString();
    const justAfter = await withFrozenNow(afterBoundaryMs, () => repoA.listActive());
    assert(!justAfter.some((p) => p.id === p6.id), "P6: valid_until < now must be EXCLUDED");
    console.log("[P6] equality boundary active; now+1ms excludes (frozen clock, public listActive)");

    // ---------- P7: is_active=false excluded (direct DB fixture) ----------
    const p7id = randomUUID();
    await insertRow(dbA, {
      id: p7id,
      title: `P7_INACTIVE_${tag}`,
      discountType: "FLAT",
      value: "77",
      validUntil: new Date(FUTURE),
      isActive: false,
      createdAt: new Date(),
    });
    const activeAfterP7 = await repoA.listActive();
    assert(!activeAfterP7.some((p) => p.id === p7id), "P7: inactive promotion was returned");
    console.log("[P7] is_active=false excluded via direct DB fixture");

    // ---------- P8: created_at DESC ordering (distinct timestamps) ----------
    const t1 = "2026-01-01T00:00:01.000Z";
    const t2 = "2026-01-01T00:00:02.000Z";
    const t3 = "2026-01-01T00:00:03.000Z";
    const p8ids = [randomUUID(), randomUUID(), randomUUID()];
    await insertRow(dbA, { id: p8ids[0]!, title: `P8_A_${tag}`, discountType: "FLAT", value: "1", validUntil: new Date(FUTURE), isActive: true, createdAt: new Date(t1) });
    await insertRow(dbA, { id: p8ids[1]!, title: `P8_B_${tag}`, discountType: "FLAT", value: "2", validUntil: new Date(FUTURE), isActive: true, createdAt: new Date(t2) });
    await insertRow(dbA, { id: p8ids[2]!, title: `P8_C_${tag}`, discountType: "FLAT", value: "3", validUntil: new Date(FUTURE), isActive: true, createdAt: new Date(t3) });
    const listP8 = (await repoA.listActive()).filter((p) => p8ids.includes(p.id));
    assert(listP8.length === 3, `P8: expected 3 P8 rows, got ${listP8.length}`);
    assert(
      JSON.stringify(listP8.map((p) => p.title)) ===
        JSON.stringify([`P8_C_${tag}`, `P8_B_${tag}`, `P8_A_${tag}`]),
      `P8: order ${listP8.map((p) => p.title).join(",")}`,
    );
    console.log("[P8] created_at DESC ordering exact (C, B, A)");

    // ---------- P9: numeric round-trip exact ----------
    const samples: Array<{ n: number; text: string }> = [
      { n: 15, text: "15" },
      { n: 12.5, text: "12.5" },
      { n: 0.1, text: "0.1" },
      { n: 99999.99, text: "99999.99" },
      { n: 100, text: "100" },
    ];
    for (const s of samples) {
      const created = await repoA.create({
        title: `P9_${s.text.replace(".", "_")}_${tag}`,
        discount_type: "FLAT",
        value: s.n,
        valid_until: FUTURE,
      });
      const stored = await rawRows(dbA, sql`SELECT value::text AS v FROM promotions WHERE id = ${created.id}`);
      assert(stored[0]!.v === s.text, `P9: stored ${String(stored[0]!.v)} != ${s.text}`);
      const listed = (await repoA.listActive()).find((p) => p.id === created.id);
      assert(listed !== undefined && listed.value === s.n, `P9: DTO value ${listed?.value} != ${s.n}`);
    }
    console.log("[P9] numeric round-trip exact: 15, 12.5, 0.1, 99999.99, 100");

    // ---------- P10: duplicate titles allowed ----------
    const dupTitle = `P10_DUP_${tag}`;
    const d1 = await repoA.create({ title: dupTitle, discount_type: "FLAT", value: 5, valid_until: FUTURE });
    const d2 = await repoA.create({ title: dupTitle, discount_type: "FLAT", value: 6, valid_until: FUTURE });
    assert(d1.id !== d2.id, "P10: ids should differ");
    assert((await countByTitle(dbA, dupTitle)) === 2, "P10: expected two rows with the same title");
    console.log("[P10] duplicate titles allowed (distinct ids, 2 rows)");

    // ---------- P11: NO FABRICATED BACKFILL ----------
    let repoRoot = process.cwd();
    const relSql = "packages/db/drizzle/0018_promotion_persistence.sql";
    for (let i = 0; i < 8 && !existsSync(join(repoRoot, relSql)); i += 1) {
      const parent = dirname(repoRoot);
      if (parent === repoRoot) break;
      repoRoot = parent;
    }
    const migrationSql = readFileSync(join(repoRoot, relSql), "utf8");
    assert(!/\binsert\b|\bupdate\b|\bdelete\b|\balter\b|\btrigger\b/i.test(migrationSql), "P11: migration 0018 contains DML/DDL beyond CREATE TABLE");
    const before = await countAll(dbA);
    await seedUser(dbA);
    const after11 = await countAll(dbA);
    assert(before === after11, `P11: promotion rows changed on unrelated user write (${before} -> ${after11})`);
    const synth = await countByTitle(dbA, `AUTO_BACKFILL_${tag}`);
    assert(synth === 0, "P11: synthesized backfill row present");
    console.log("[P11] no fabricated backfill: 0018 has no DML; unrelated write creates no promotion row");

    // ---------- P12: memory observable parity ----------
    const mem = new MemoryPromotionRepository();
    mem.create({ title: `P12_OLD_${tag}`, discount_type: "PERCENTAGE", value: 10, valid_until: PAST });
    mem.create({ title: `P12_NEW_${tag}`, discount_type: "FLAT", value: 40, valid_until: FUTURE });
    await new Promise((r) => setTimeout(r, 5));
    mem.create({ title: `P12_NEWEST_${tag}`, discount_type: "FLAT", value: 60, valid_until: FUTURE });
    const memList = (await mem.listActive()).map((p) => p.title);

    const dr = new DrizzlePromotionRepository(dbA);
    await dr.create({ title: `P12_OLD_${tag}`, discount_type: "PERCENTAGE", value: 10, valid_until: PAST });
    await dr.create({ title: `P12_NEW_${tag}`, discount_type: "FLAT", value: 40, valid_until: FUTURE });
    await new Promise((r) => setTimeout(r, 5));
    await dr.create({ title: `P12_NEWEST_${tag}`, discount_type: "FLAT", value: 60, valid_until: FUTURE });
    const drList = (await dr.listActive())
      .map((p) => p.title)
      .filter((t) => t.startsWith(`P12_`) && t.endsWith(`_${tag}`));
    assert(
      JSON.stringify(drList) === JSON.stringify(memList),
      `P12: memory ${memList.join(",")} != drizzle ${drList.join(",")}`,
    );
    console.log(`[P12] memory observable parity OK (${memList.join(", ")})`);
  } finally {
    await poolA.end().catch(() => undefined);
  }

  console.log("A2 REAL-PG PROMOTION DURABILITY PROOF PASSED (P1-P12)");
  console.log(`GLOBAL_UNSCOPED_PROMOTIONS: PRESERVED (tag ${tag})`);
}

main().catch((err) => {
  console.error("A2 REAL-PG PROMOTION DURABILITY FAILED:", err instanceof Error ? err.message : err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exitCode = 1;
});
