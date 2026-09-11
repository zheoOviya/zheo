// ============================================================
// CUSTOM-ROLE-PG-DURABILITY-A2 - REAL-POSTGRES DURABILITY PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (migration
// 0017_custom_role_persistence.sql must have been applied):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://<user>:<pw>@127.0.0.1:5432/<disposable_db> \
//   pnpm exec tsx apps/api/integration/realPgCustomRolePersistence.ts
//
// PROVES (and only claims):
//   P1  custom_roles table + exact column metadata after migration 0017.
//   P2  custom_roles_name_uq exists, is UNIQUE, is on (name); custom_roles
//       has no foreign keys and nothing references it.
//   P3  create persists the row and returns the exact CustomRole DTO, and an
//       independent read round-trips it.
//   P4  list() ordering is deterministic (name ascending; Memory parity).
//   P5  duplicate name -> PG 23505 on custom_roles_name_uq -> exact
//       AppError CONFLICT/409; exactly one row remains.
//   P6  a 23505 on a DIFFERENT constraint is NOT mapped to a role conflict
//       (rethrows raw) - proves the translation is narrow, runs LAST.
//   P7  restart durability: close the first pool, a fresh pool/repo reads it.
//   P8  cross-instance: instance A creates; independent instance B reads/lists.
//   P9  remove(existing) -> true; second remove -> false; getByName -> null.
//   P10 no-backfill: built-ins are absent and an orphan users.role string does
//       NOT create a catalog row; users.role is untouched.
//   P11 concurrent same-name create via two independent pools -> exactly one
//       success + one CONFLICT/409; the DB unique constraint is the arbiter.
//   P12 accepted delete-vs-assign race limitation is DEMONSTRATED and left
//       unrepaired (orphan users.role string with no catalog row).
//   P13 [section 9] after restart, role lookup through DrizzleRoleRepository
//       still succeeds and a production assignment validates against it.
//
// Memory-parity alone is not a durability proof; this harness talks to the
// real table through real connection pools. Disposable rows are left in the
// disposable DB by design (no destructive cleanup).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { DrizzleRoleRepository } from "../src/repositories/drizzle/drizzleRoleRepository";
import { DrizzleIdentityRepository } from "../src/repositories/drizzle/drizzleIdentityRepository";
import { AppError } from "../src/middleware/envelope";
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

/** Walks the error cause chain to the Postgres SQLSTATE + constraint name. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  let cur = err as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (typeof cur.code === "string") {
      return {
        code: cur.code,
        constraint: typeof cur.constraint === "string" ? cur.constraint : undefined,
      };
    }
    cur = cur.cause as typeof cur;
  }
  return {};
}

async function seedUser(db: DrizzleDb, role: string): Promise<string> {
  const id = randomUUID();
  await (db as unknown as RawDb).execute(
    sql`INSERT INTO users (id, phone, role, created_at) VALUES (${id}, ${"cr-" + randomUUID()}, ${role}, now())`,
  );
  return id;
}

async function countRows(db: DrizzleDb, name: string): Promise<number> {
  const rows = (
    await (db as unknown as RawDb).execute(
      sql`SELECT count(*)::int AS n FROM custom_roles WHERE name = ${name}`,
    )
  ).rows;
  return rows[0]!.n as number;
}

async function userRole(db: DrizzleDb, userId: string): Promise<string> {
  const rows = (
    await (db as unknown as RawDb).execute(
      sql`SELECT role FROM users WHERE id = ${userId}`,
    )
  ).rows;
  return rows[0]!.role as string;
}

function payload(name: string, label: string) {
  return {
    name,
    label,
    description: `desc for ${name}`,
    permissions: ["perm.a", "perm.b"],
  };
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG custom-role durability proof starting...");
  const tag = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

  const poolA = new Pool({ connectionString: dbUrl, max: 4 });
  const dbA = makeDb(poolA);
  const rawA = dbA as unknown as RawDb;
  const repoA = new DrizzleRoleRepository(dbA);

  const p3Name = `P3_ROLE_${tag}`;

  try {
    // ---------- P1: schema/table/column metadata ----------
    const cols = (
      await rawA.execute(
        sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='custom_roles' ORDER BY ordinal_position`,
      )
    ).rows;
    const names = cols.map((c) => c.column_name as string);
    assert(
      JSON.stringify(names) ===
        JSON.stringify(["id", "name", "label", "description", "permissions", "created_at"]),
      `P1: unexpected columns ${names.join(",")}`,
    );
    const byName = (n: string) => cols.find((c) => c.column_name === n)!;
    assert(byName("id").data_type === "uuid" && byName("id").is_nullable === "NO", "P1: id metadata");
    assert(String(byName("id").column_default).includes("gen_random_uuid"), "P1: id default");
    for (const c of ["name", "label", "description"]) {
      assert(byName(c).data_type === "text" && byName(c).is_nullable === "NO", `P1: ${c} metadata`);
    }
    assert(byName("permissions").data_type === "jsonb" && byName("permissions").is_nullable === "NO", "P1: permissions metadata");
    assert(String(byName("permissions").column_default) === "'[]'::jsonb", "P1: permissions default");
    assert(
      byName("created_at").data_type === "timestamp with time zone" && byName("created_at").is_nullable === "NO",
      "P1: created_at metadata",
    );
    assert(String(byName("created_at").column_default) === "now()", "P1: created_at default");
    console.log(`[P1] custom_roles columns exact: ${names.join(", ")}`);

    // ---------- P2: unique index + no FKs ----------
    const uq = (
      await rawA.execute(
        sql`SELECT c.relname, i.indisunique, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'custom_roles_name_uq'`,
      )
    ).rows;
    assert(uq.length === 1, "P2: custom_roles_name_uq missing");
    assert(uq[0]!.indisunique === true, "P2: custom_roles_name_uq is not UNIQUE");
    assert(String(uq[0]!.def).includes("(name)"), `P2: index not on (name): ${uq[0]!.def}`);
    const fkOut = (
      await rawA.execute(
        sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'custom_roles'::regclass AND contype = 'f'`,
      )
    ).rows[0]!.n as number;
    const fkIn = (
      await rawA.execute(
        sql`SELECT count(*)::int AS n FROM pg_constraint WHERE confrelid = 'custom_roles'::regclass`,
      )
    ).rows[0]!.n as number;
    assert(fkOut === 0, `P2: custom_roles unexpectedly has ${fkOut} FK(s)`);
    assert(fkIn === 0, `P2: ${fkIn} FK(s) reference custom_roles`);
    console.log(`[P2] unique index custom_roles_name_uq verified; FK in/out = 0/0`);

    // ---------- P3: create + exact DTO + read ----------
    const created3 = await repoA.create(payload(p3Name, `LBL_P3_${tag}`));
    assert(created3.name === p3Name && created3.label === `LBL_P3_${tag}`, "P3: create returned wrong fields");
    assert(Array.isArray(created3.permissions) && created3.permissions.length === 2, "P3: permissions not array");
    assert(typeof created3.id === "string" && created3.id.length > 0, "P3: id missing");
    assert(typeof created3.created_at === "string" && !Number.isNaN(Date.parse(created3.created_at)), "P3: created_at not ISO");
    const read3 = await repoA.getByName(p3Name);
    assert(read3 !== null, "P3: getByName returned null");
    assert(JSON.stringify(read3) === JSON.stringify(created3), "P3: read DTO differs from created DTO");
    const rawRow = (
      await rawA.execute(sql`SELECT name, label, description, permissions FROM custom_roles WHERE name = ${p3Name}`)
    ).rows[0]!;
    assert(JSON.stringify(rawRow.permissions) === JSON.stringify(["perm.a", "perm.b"]), "P3: raw permissions mismatch");
    console.log(`[P3] create+read exact DTO for ${p3Name}`);

    // ---------- P4: deterministic ordering ----------
    const oName = (s: string) => `P4_${s}_${tag}`;
    await repoA.create(payload(oName("MIKE"), `LBL_P4M_${tag}`));
    await repoA.create(payload(oName("ALPHA"), `LBL_P4A_${tag}`));
    await repoA.create(payload(oName("ZED"), `LBL_P4Z_${tag}`));
    const list4 = await repoA.list();
    const allNames = list4.map((r) => r.name);
    const sorted = [...allNames].sort((a, b) => a.localeCompare(b));
    assert(JSON.stringify(allNames) === JSON.stringify(sorted), "P4: list() not name-ascending");
    const mine4 = allNames.filter((n) => n.startsWith("P4_") && n.endsWith(`_${tag}`));
    assert(
      JSON.stringify(mine4) === JSON.stringify([oName("ALPHA"), oName("MIKE"), oName("ZED")]),
      `P4: unexpected order ${mine4.join(",")}`,
    );
    console.log(`[P4] list() deterministic ascending; probe order = ${mine4.join(", ")}`);

    // ---------- P5: duplicate -> exact CONFLICT/409 ----------
    let p5Err: unknown;
    try {
      await repoA.create(payload(p3Name, `LBL_P3_${tag}`));
    } catch (err) {
      p5Err = err;
    }
    assert(p5Err instanceof AppError, `P5: expected AppError, got ${String(p5Err)}`);
    assert(p5Err.code === "CONFLICT", `P5: code=${p5Err.code}`);
    assert(p5Err.status === 409, `P5: status=${p5Err.status}`);
    assert(p5Err.message === `Role '${p3Name}' already exists`, `P5: message=${p5Err.message}`);
    assert((await countRows(dbA, p3Name)) === 1, "P5: duplicate created an extra row");
    console.log(`[P5] duplicate -> ${p5Err.code}/${p5Err.status} "${p5Err.message}"`);

    // ---------- P8: cross-instance A create -> B read/list ----------
    const poolB = new Pool({ connectionString: dbUrl, max: 1 });
    const repoB = new DrizzleRoleRepository(makeDb(poolB));
    try {
      const pidA = (await rawA.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid as number;
      const pidB = (
        await (makeDb(poolB) as unknown as RawDb).execute(sql`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid as number;
      assert(pidA !== pidB, `P8: pools share backend pid ${pidA}`);
      const viaB = await repoB.getByName(p3Name);
      assert(viaB !== null && viaB.id === created3.id, "P8: independent instance did not read role");
      assert((await repoB.list()).some((r) => r.name === p3Name), "P8: independent list missing role");
      console.log(`[P8] cross-instance read OK (pidA=${pidA} pidB=${pidB})`);
    } finally {
      await poolB.end();
    }

    // ---------- P13/section 9: restart + production assignment path ----------
    await poolA.end();
    const poolC = new Pool({ connectionString: dbUrl, max: 2 });
    const dbC = makeDb(poolC);
    const repoC = new DrizzleRoleRepository(dbC);
    const idRepoC = new DrizzleIdentityRepository(dbC);
    try {
      const afterRestart = await repoC.getByName(p3Name);
      assert(afterRestart !== null && afterRestart.id === created3.id, "P7: role lost after restart");
      assert((await repoC.list()).some((r) => r.name === p3Name), "P7: list lost role after restart");
      console.log(`[P7] restart durability OK for ${p3Name}`);

      const assignee = await seedUser(dbC, "CONSUMER");
      const updated = await idRepoC.updateRole(assignee, p3Name);
      assert(updated !== null && updated.role === p3Name, "P13: updateRole failed");
      assert((await repoC.getByName(p3Name)) !== null, "P13: catalog lookup failed after restart");
      assert((await userRole(dbC, assignee)) === p3Name, "P13: assignment not persisted");
      console.log(`[P13] post-restart assignment validated against persisted catalog`);

      // ---------- P9: remove true/false ----------
      const p9Name = `P9_ROLE_${tag}`;
      await repoC.create(payload(p9Name, `LBL_P9_${tag}`));
      assert((await repoC.remove(p9Name)) === true, "P9: first remove should be true");
      assert((await repoC.remove(p9Name)) === false, "P9: second remove should be false");
      assert((await repoC.getByName(p9Name)) === null, "P9: role still present after remove");
      console.log(`[P9] remove true -> false; getByName null`);

      // ---------- P10: no-backfill ----------
      const builtinRows = (
        await (dbC as unknown as RawDb).execute(
          sql`SELECT count(*)::int AS n FROM custom_roles WHERE name IN ('CONSUMER','VENDOR_OWNER','VENDOR_STAFF','OPS_AGENT','ADMIN','SUPER_ADMIN')`,
        )
      ).rows[0]!.n as number;
      assert(builtinRows === 0, `P10: ${builtinRows} built-in name(s) present in custom_roles`);
      const orphanRole = `ORPHAN_${tag}`;
      const orphanUser = await seedUser(dbC, orphanRole);
      assert((await repoC.getByName(orphanRole)) === null, "P10: orphan role unexpectedly has a catalog row");
      assert((await countRows(dbC, orphanRole)) === 0, "P10: orphan role created a catalog row");
      assert((await userRole(dbC, orphanUser)) === orphanRole, "P10: users.role was rewritten");
      console.log(`[P10] no backfill: built-ins absent; orphan users.role untouched`);

      // ---------- P11: concurrent same-name create (DB is the arbiter) ----------
      const poolD = new Pool({ connectionString: dbUrl, max: 1 });
      const poolE = new Pool({ connectionString: dbUrl, max: 1 });
      try {
        const dbD = makeDb(poolD);
        const dbE = makeDb(poolE);
        const repoD = new DrizzleRoleRepository(dbD);
        const repoE = new DrizzleRoleRepository(dbE);
        const dupName = `P11_DUP_${tag}`;
        const dupPayload = () => payload(dupName, `LBL_P11_${tag}`);
        const pidD = (await (dbD as unknown as RawDb).execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid as number;
        const pidE = (await (dbE as unknown as RawDb).execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid as number;
        assert(pidD !== pidE, `P11: concurrent pools share backend pid ${pidD}`);
        const settled = await Promise.allSettled([repoD.create(dupPayload()), repoE.create(dupPayload())]);
        const fulfilled = settled.filter((s) => s.status === "fulfilled");
        const rejected = settled.filter((s) => s.status === "rejected");
        assert(fulfilled.length === 1, `P11: expected 1 success, got ${fulfilled.length}`);
        assert(rejected.length === 1, `P11: expected 1 conflict, got ${rejected.length}`);
        const reason = (rejected[0] as PromiseRejectedResult).reason;
        assert(reason instanceof AppError, `P11: loser error not AppError (${String(reason)})`);
        assert(reason.code === "CONFLICT" && reason.status === 409, `P11: loser ${reason.code}/${reason.status}`);
        assert((await countRows(dbD, dupName)) === 1, "P11: expected exactly one surviving row");
        console.log(`[P11] concurrent same-name create -> 1 success + 1 CONFLICT/409 (pids ${pidD},${pidE})`);
      } finally {
        await poolD.end();
        await poolE.end();
      }

      // ---------- P12: accepted delete-vs-assign limitation (NOT repaired) ----------
      const poolF = new Pool({ connectionString: dbUrl, max: 2 });
      const poolG = new Pool({ connectionString: dbUrl, max: 2 });
      try {
        const dbF = makeDb(poolF);
        const dbG = makeDb(poolG);
        const repoF = new DrizzleRoleRepository(dbF);
        const idRepoG = new DrizzleIdentityRepository(dbG);
        const victim = `P12_VICTIM_${tag}`;
        await repoF.create(payload(victim, `LBL_P12_${tag}`));
        // Assign pre-check sees the role (step 1).
        assert((await repoF.getByName(victim)) !== null, "P12: precheck failed");
        const assignee = await seedUser(dbF, "CONSUMER");
        // Delete counts 0 assigned users (step 2) and removes the role (step 3).
        const assignedCount = (
          await (dbG as unknown as RawDb).execute(
            sql`SELECT count(*)::int AS n FROM users WHERE role = ${victim}`,
          )
        ).rows[0]!.n as number;
        assert(assignedCount === 0, "P12: victim unexpectedly assigned before delete");
        assert((await repoF.remove(victim)) === true, "P12: delete failed");
        // Assign writes users.role AFTER the delete passed its count (step 4).
        const updated = await idRepoG.updateRole(assignee, victim);
        assert(updated !== null && updated.role === victim, "P12: orphan write failed to simulate");
        assert((await repoF.getByName(victim)) === null, "P12: role catalog row should be gone");
        assert((await userRole(dbF, assignee)) === victim, "P12: orphan users.role not present");
        console.log(
          "[P12] ACCEPTED_PRE_EXISTING_LIMITATION demonstrated: orphan users.role persisted with no catalog row (left unrepaired)",
        );
      } finally {
        await poolF.end();
        await poolG.end();
      }

      // ---------- P6 (LAST): unrelated 23505 is NOT mapped ----------
      // A runtime-only probe unique index on a non-name column lets us force a
      // 23505 on a *different* constraint through repo.create and prove the
      // translation is narrow. It is never part of migration 0017.
      await (dbC as unknown as RawDb).execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_label_probe_uq ON custom_roles(label)`,
      );
      const probeLabel = `LBL_P6_SHARED_${tag}`;
      await repoC.create(payload(`P6_A_${tag}`, probeLabel));
      let p6Err: unknown;
      try {
        await repoC.create(payload(`P6_B_${tag}`, probeLabel));
      } catch (err) {
        p6Err = err;
      }
      assert(p6Err !== undefined, "P6: expected a 23505 from the non-name constraint");
      const pe = pgError(p6Err);
      assert(pe.code === "23505", `P6: expected 23505, got ${pe.code ?? "none"}`);
      assert(
        pe.constraint === "custom_roles_label_probe_uq",
        `P6: unexpected constraint ${pe.constraint ?? "none"}`,
      );
      assert(
        !(p6Err instanceof AppError && p6Err.code === "CONFLICT"),
        "P6: unrelated 23505 was wrongly mapped to CONFLICT",
      );
      console.log(`[P6] unrelated 23505 (${pe.constraint}) rethrown, not mapped to CONFLICT`);
    } finally {
      await poolC.end();
    }
  } finally {
    await poolA.end().catch(() => undefined);
  }

  console.log("A2 REAL-PG CUSTOM-ROLE DURABILITY PROOF PASSED (P1-P13)");
  console.log(`A2 custom role kept in disposable DB for manual inspection: ${p3Name}`);
}

main().catch((err) => {
  console.error("A2 REAL-PG CUSTOM-ROLE DURABILITY FAILED:", err instanceof Error ? err.message : err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exitCode = 1;
});
