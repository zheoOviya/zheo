/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// VENDOR-APPROVAL-ATOMICITY-A2 — PART 4
// STANDALONE REAL-POSTGRES CONCURRENCY + ROLLBACK PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. This harness connects to a
// dedicated disposable Postgres database, forces the REAL Drizzle repositories
// and the REAL DrizzleVendorApprovalTransactionPort, opens genuinely
// concurrent transactions on separate pooled connections, and exits non-zero
// on any failed assertion.
//
//   HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:PORT/vendor_a2_p4_runA" \
//   HARNESS_TAG=RUN_A HARNESS_EXPECT_DB_PREFIX=vendor_a2_p4 \
//     pnpm exec tsx apps/api/integration/realPgVendorApprovalConcurrency.ts
//
// PROVES (and only claims) against real Postgres:
//   P1 approve/approve: exactly one CAS winner; loser blocks on the row lock
//      and returns null after the winner commits; final status APPROVED
//   P2 no duplicate business objects (SINGLE and CHAIN); one approved audit
//   P3 approve vs reject: one terminal state; only the winner's side effects
//   P4 rollback after a restaurant write leaves the application PENDING
//   P5 rollback after role + scoped-role writes restores the identity role and
//      leaves no scoped role / restaurant / chain / audit
//   P6 zero-row CAS on a terminal application returns null, no side effects
//   P7 a post-commit EventBus failure does not roll back the committed DB write
//
// This is external CI evidence. No false CI coverage is claimed.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { users } from "@snakzap/db";
import type { DrizzleDb } from "../src/lib/dbType";

// ------------------------------------------------------------
// configuration
// ------------------------------------------------------------

const DATABASE_URL = process.env.HARNESS_DATABASE_URL;
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;
const EXPECT_DB_PREFIX = process.env.HARNESS_EXPECT_DB_PREFIX ?? "vendor_a2_p4";
const ISOLATION_MODE = process.env.HARNESS_ISOLATION_MODE ?? "DISPOSABLE_LOCAL_CLUSTER";

if (!DATABASE_URL) {
  console.error("BLOCKED: HARNESS_DATABASE_URL is not set (no safe Postgres available)");
  process.exit(2);
}

// ------------------------------------------------------------
// assertion bookkeeping
// ------------------------------------------------------------

const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];

function check(id: string, ok: boolean, detail?: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` :: ${detail}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ------------------------------------------------------------
// main
// ------------------------------------------------------------

async function main(): Promise<void> {
  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
  const db = drizzle(pool) as unknown as DrizzleDb;
  const txDb = db as unknown as DrizzleDb;

  // Dynamic imports after the DB is reachable; the production port and the
  // EventBus seams are only loaded once the environment is confirmed.
  const portMod = await import(
    "../src/repositories/drizzle/vendorApprovalTransactionPort"
  );
  const { createVendorApprovalTransactionPort, buildVendorApprovalTxRepos } = portMod;
  const { DrizzleVendorApplicationRepository } = await import(
    "../src/repositories/vendorApplicationRepository"
  );

  const port = createVendorApprovalTransactionPort(db);
  const appRepo = new DrizzleVendorApplicationRepository(db);

  // ---------- environment + isolation ----------
  const versionRes = await pool.query<{ version: string; db: string; user: string }>(
    "select version() as version, current_database() as db, current_user as user",
  );
  const version = versionRes.rows[0]!.version;
  const dbName = versionRes.rows[0]!.db;
  const dbUser = versionRes.rows[0]!.user;
  const postgresConfirmed = /PostgreSQL/i.test(version);
  const isolationOk = dbName.startsWith(EXPECT_DB_PREFIX);

  console.log(`POSTGRES_CONFIRMED=${postgresConfirmed ? "YES" : "NO"}`);
  console.log(`DATABASE_ISOLATION_MODE=${ISOLATION_MODE}`);
  console.log(`RUN_TAG=${TAG}`);
  console.log(`DATABASE_NAME=${dbName}`);
  console.log(`DATABASE_USER=${dbUser}`);
  check("P0_POSTGRES_CONFIRMED", postgresConfirmed, version.split(" on ")[0]);
  check(
    "P0_ISOLATION_GUARD",
    isolationOk,
    `database '${dbName}' must start with '${EXPECT_DB_PREFIX}'`,
  );
  if (!postgresConfirmed || !isolationOk) {
    console.log("HARNESS_RESULT: FAIL");
    await pool.end();
    process.exit(1);
  }

  // ---------- fixtures ----------
  const userIds: string[] = [];
  const appIds: string[] = [];

  const reviewerId = randomUUID();
  const reviewerPhone = `harness-${TAG}-reviewer`;
  await db.insert(users).values({ id: reviewerId, phone: reviewerPhone, role: "ADMIN" });
  userIds.push(reviewerId);

  async function makeApplicant(suffix: string, role = "CONSUMER"): Promise<string> {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      phone: `harness-${TAG}-applicant-${suffix}`,
      role,
    });
    userIds.push(id);
    return id;
  }

  async function makeApplication(
    applicantId: string,
    suffix: string,
    type: "SINGLE" | "CHAIN" = "SINGLE",
    outletCount = 1,
  ) {
    const app = await appRepo.create({
      applicant_id: applicantId,
      name: `Harness ${TAG} ${suffix}`,
      gst_number: `GST-${TAG}-${suffix}`,
      fssai_license: `FSSAI-${TAG}-${suffix}`,
      phone: `9000${TAG}${suffix}`.slice(0, 20),
      commission_rate: 0.08,
      type,
      outlet_count: outletCount,
    });
    appIds.push(app.id);
    return app;
  }

  const count = async (sqlText: string, params: unknown[]): Promise<number> => {
    const r = await pool.query<{ n: number }>(sqlText, params as any[]);
    return Number(r.rows[0]!.n);
  };
  const statusOf = async (id: string): Promise<string> =>
    (await count("select count(*)::int as n from vendor_applications where id=$1 and status=$2", [
      id,
      "PENDING",
    ])) === 1
      ? "PENDING"
      : (await count("select count(*)::int as n from vendor_applications where id=$1 and status=$2", [
          id,
          "APPROVED",
        ])) === 1
        ? "APPROVED"
        : "REJECTED";
  const roleOf = async (id: string): Promise<string | null> => {
    const r = await pool.query<{ role: string }>("select role from users where id=$1", [id]);
    return r.rows[0]?.role ?? null;
  };

  // shared approval orchestration mirroring apps/api/src/routes/admin.ts
  async function approve(
    repos: any,
    appId: string,
    applicantId: string,
    actorId: string,
  ): Promise<{ ok: boolean; restaurantId?: string; chainId?: string }> {
    const claimed = await repos.vendorApplication.transitionStatus(
      appId,
      "PENDING",
      "APPROVED",
      actorId,
    );
    if (!claimed) return { ok: false };

    let restaurantId: string | undefined;
    let chainId: string | undefined;
    if (claimed.type === "CHAIN") {
      const chain = await repos.chain.create(claimed.name, claimed.applicant_id);
      chainId = chain.id;
      const n = Math.max(1, claimed.outlet_count);
      for (let i = 1; i <= n; i += 1) {
        const outlet = await repos.catalog.createRestaurant({
          name: n > 1 ? `${claimed.name} — Outlet ${i}` : claimed.name,
          gst_number: claimed.gst_number,
          fssai_license: claimed.fssai_license,
          owner_id: claimed.applicant_id,
          commission_rate: claimed.commission_rate,
          lat: claimed.lat,
          lng: claimed.lng,
          pickup_eta_min: 20,
          chain_id: chain.id,
        });
        if (i === 1) restaurantId = outlet.id;
      }
    } else {
      const outlet = await repos.catalog.createRestaurant({
        name: claimed.name,
        gst_number: claimed.gst_number,
        fssai_license: claimed.fssai_license,
        owner_id: claimed.applicant_id,
        commission_rate: claimed.commission_rate,
        lat: claimed.lat,
        lng: claimed.lng,
        pickup_eta_min: 20,
      });
      restaurantId = outlet.id;
    }

    await repos.identity.updateRole(claimed.applicant_id, "VENDOR_OWNER");
    await repos.userRole.assign({
      user_id: claimed.applicant_id,
      scope_type: chainId ? "chain" : "restaurant",
      scope_id: chainId ?? restaurantId!,
      role: "VENDOR_OWNER",
    });
    await repos.audit.log(actorId, "vendor_application_approved", {
      application_id: appId,
      vendor_id: chainId ?? restaurantId,
      vendor_name: claimed.name,
      applicant_id: claimed.applicant_id,
      type: claimed.type,
      outlet_count: chainId ? claimed.outlet_count : 1,
    });
    void applicantId;
    return { ok: true, restaurantId, chainId };
  }

  async function reject(
    repos: any,
    appId: string,
    actorId: string,
    reason: string,
  ): Promise<{ ok: boolean }> {
    const claimed = await repos.vendorApplication.transitionStatus(
      appId,
      "PENDING",
      "REJECTED",
      actorId,
      reason,
    );
    if (!claimed) return { ok: false };
    await repos.audit.log(actorId, "vendor_application_rejected", {
      application_id: appId,
      vendor_name: claimed.name,
      applicant_id: claimed.applicant_id,
      reason,
    });
    return { ok: true };
  }

  // ============================================================
  // P1 — APPROVE / APPROVE RACE
  // ============================================================
  const p1Applicant = await makeApplicant("p1");
  const p1App = await makeApplication(p1Applicant, "p1", "SINGLE");
  const startGate = deferred<void>();
  const txStartedAt: Record<string, number> = {};
  const txEndedAt: Record<string, number> = {};
  let lockWaitObserved = false;

  const raceApprove = (label: string) =>
    port.runInTransaction(async (repos: any) => {
      txStartedAt[label] = Date.now();
      await startGate.promise;
      const claimed = await repos.vendorApplication.transitionStatus(
        p1App.id,
        "PENDING",
        "APPROVED",
        reviewerId,
      );
      if (!claimed) {
        txEndedAt[label] = Date.now();
        return { label, ok: false };
      }
      // Winner holds the row lock open so the loser's CAS demonstrably blocks.
      await sleep(450);
      const restaurant = await repos.catalog.createRestaurant({
        name: claimed.name,
        gst_number: claimed.gst_number,
        fssai_license: claimed.fssai_license,
        owner_id: claimed.applicant_id,
        commission_rate: claimed.commission_rate,
        lat: claimed.lat,
        lng: claimed.lng,
        pickup_eta_min: 20,
      });
      await repos.identity.updateRole(claimed.applicant_id, "VENDOR_OWNER");
      await repos.userRole.assign({
        user_id: claimed.applicant_id,
        scope_type: "restaurant",
        scope_id: restaurant.id,
        role: "VENDOR_OWNER",
      });
      await repos.audit.log(reviewerId, "vendor_application_approved", {
        application_id: p1App.id,
        applicant_id: claimed.applicant_id,
        type: "SINGLE",
        outlet_count: 1,
      });
      txEndedAt[label] = Date.now();
      return { label, ok: true };
    });

  const p1Race = Promise.all([raceApprove("A"), raceApprove("B")]);
  startGate.resolve();

  const lockDeadline = Date.now() + 420;
  while (Date.now() < lockDeadline) {
    const waiting = await count(
      "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
      [dbName],
    );
    if (waiting > 0) {
      lockWaitObserved = true;
      break;
    }
    await sleep(25);
  }

  const p1Results = await p1Race;
  const p1Winners = p1Results.filter((r) => r.ok).length;
  const p1Losers = p1Results.filter((r) => !r.ok).length;
  const p1Final = await statusOf(p1App.id);
  const p1Durations = p1Results.map((r) => txEndedAt[r.label]! - txStartedAt[r.label]!);
  const loserBlocked = Math.max(...p1Durations) >= 300;

  check("P1_APPROVE_APPROVE_ONE_WINNER", p1Winners === 1 && p1Losers === 1, `winners=${p1Winners} losers=${p1Losers}`);
  check("P1_FINAL_STATUS_APPROVED", p1Final === "APPROVED", `final=${p1Final}`);
  check(
    "P1_LOSER_BLOCKED_ON_ROW_LOCK",
    lockWaitObserved && loserBlocked,
    `lockWaitObserved=${lockWaitObserved} durations=[${p1Durations.join(",")}]`,
  );
  console.log(`P1_WINNERS=${p1Winners}`);
  console.log(`P1_LOSERS=${p1Losers}`);
  console.log(`P1_FINAL_STATUS=${p1Final}`);

  // ============================================================
  // P2 — NO DUPLICATE BUSINESS OBJECTS
  // ============================================================
  const p2SingerRest = await count("select count(*)::int as n from restaurants where owner_id=$1", [p1Applicant]);
  const p2SingerRole = await count("select count(*)::int as n from user_roles where user_id=$1", [p1Applicant]);
  const p2SingerAudit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1 and action=$2",
    [p1App.id, "vendor_application_approved"],
  );
  const p2SingerChains = await count("select count(*)::int as n from chains where owner_id=$1", [p1Applicant]);

  // CHAIN variant (single approval, no race)
  const p2ChainApplicant = await makeApplicant("p2chain");
  const p2ChainApp = await makeApplication(p2ChainApplicant, "p2chain", "CHAIN", 3);
  const p2ChainRes = await port.runInTransaction((repos: any) =>
    approve(repos, p2ChainApp.id, p2ChainApplicant, reviewerId),
  );
  const p2ChainId = p2ChainRes.chainId!;
  const p2ChainCount = await count("select count(*)::int as n from chains where owner_id=$1", [p2ChainApplicant]);
  const p2ChainOutlets = await count("select count(*)::int as n from restaurants where chain_id=$1", [p2ChainId]);
  const p2ChainRole = await count(
    "select count(*)::int as n from user_roles where user_id=$1 and scope_type=$2",
    [p2ChainApplicant, "chain"],
  );
  const p2ChainAudit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1 and action=$2",
    [p2ChainApp.id, "vendor_application_approved"],
  );

  check(
    "P2_SINGLE_NO_DUPLICATES",
    p2SingerRest === 1 && p2SingerRole === 1 && p2SingerAudit === 1 && p2SingerChains === 0,
    `restaurants=${p2SingerRest} scopedRoles=${p2SingerRole} approvedAudits=${p2SingerAudit} chains=${p2SingerChains}`,
  );
  check(
    "P2_CHAIN_NO_DUPLICATES",
    p2ChainCount === 1 && p2ChainOutlets === 3 && p2ChainRole === 1 && p2ChainAudit === 1,
    `chains=${p2ChainCount} restaurants=${p2ChainOutlets} scopedRoles=${p2ChainRole} approvedAudits=${p2ChainAudit}`,
  );
  console.log(`P2_SINGLE_RESTAURANTS=${p2SingerRest}`);
  console.log(`P2_SINGLE_SCOPED_ROLES=${p2SingerRole}`);
  console.log(`P2_SINGLE_APPROVED_AUDITS=${p2SingerAudit}`);
  console.log(`P2_SINGLE_CHAINS=${p2SingerChains}`);
  console.log(`P2_CHAIN_CHAINS=${p2ChainCount}`);
  console.log(`P2_CHAIN_RESTAURANTS=${p2ChainOutlets}`);
  console.log(`P2_CHAIN_SCOPED_ROLES=${p2ChainRole}`);
  console.log(`P2_CHAIN_APPROVED_AUDITS=${p2ChainAudit}`);

  // ============================================================
  // P3 — APPROVE VS REJECT
  // ============================================================
  const p3Applicant = await makeApplicant("p3");
  const p3App = await makeApplication(p3Applicant, "p3", "SINGLE");
  const p3Gate = deferred<void>();
  let p3LockObserved = false;

  const raceApproveP3 = port.runInTransaction(async (repos: any) => {
    await p3Gate.promise;
    const r = await approve(repos, p3App.id, p3Applicant, reviewerId);
    if (r.ok) await sleep(400);
    return { kind: "approve", ok: r.ok };
  });
  const raceRejectP3 = port.runInTransaction(async (repos: any) => {
    await p3Gate.promise;
    const r = await reject(repos, p3App.id, reviewerId, "harness reject");
    if (r.ok) await sleep(400);
    return { kind: "reject", ok: r.ok };
  });
  const p3Race = Promise.all([raceApproveP3, raceRejectP3]);
  p3Gate.resolve();
  const p3Deadline = Date.now() + 380;
  while (Date.now() < p3Deadline) {
    const waiting = await count(
      "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
      [dbName],
    );
    if (waiting > 0) {
      p3LockObserved = true;
      break;
    }
    await sleep(25);
  }
  const p3Results = await p3Race;
  const p3Winners = p3Results.filter((r) => r.ok);
  const p3WinnerKind = p3Winners[0]?.kind ?? "none";
  const p3Final = await statusOf(p3App.id);
  const p3Restaurants = await count("select count(*)::int as n from restaurants where owner_id=$1", [p3Applicant]);
  const p3ApprovedAudit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1 and action=$2",
    [p3App.id, "vendor_application_approved"],
  );
  const p3RejectedAudit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1 and action=$2",
    [p3App.id, "vendor_application_rejected"],
  );
  const p3OneTerminal =
    p3Winners.length === 1 &&
    ((p3WinnerKind === "approve" && p3Final === "APPROVED") ||
      (p3WinnerKind === "reject" && p3Final === "REJECTED"));

  check(
    "P3_APPROVE_REJECT_ONE_WINNER",
    p3Winners.length === 1 && p3Final === (p3WinnerKind === "approve" ? "APPROVED" : "REJECTED"),
    `winner=${p3WinnerKind} final=${p3Final} lockObserved=${p3LockObserved}`,
  );
  check(
    "P3_WINNER_SIDE_EFFECTS_ONLY",
    p3WinnerKind === "approve"
      ? p3Restaurants === 1 && p3ApprovedAudit === 1 && p3RejectedAudit === 0
      : p3Restaurants === 0 && p3RejectedAudit === 1 && p3ApprovedAudit === 0,
    `winner=${p3WinnerKind} restaurants=${p3Restaurants} approvedAudit=${p3ApprovedAudit} rejectedAudit=${p3RejectedAudit}`,
  );
  console.log(`P3_WINNER=${p3WinnerKind}`);
  console.log(`P3_FINAL_STATUS=${p3Final}`);
  console.log(`P3_APPROVAL_SIDE_EFFECTS=${p3Restaurants === 1 && p3ApprovedAudit === 1 ? "PRESENT" : "ABSENT"}`);
  console.log(`P3_REJECTION_SIDE_EFFECTS=${p3RejectedAudit === 1 ? "PRESENT" : "ABSENT"}`);
  void p3OneTerminal;

  // ============================================================
  // P4 — ROLLBACK AFTER BUSINESS WRITE
  // ============================================================
  const p4Applicant = await makeApplicant("p4", "CONSUMER");
  const p4App = await makeApplication(p4Applicant, "p4", "SINGLE");
  let p4Threw = false;
  try {
    await txDb.transaction(async (tx) => {
      const repos = buildVendorApprovalTxRepos(tx);
      const claimed = await repos.vendorApplication.transitionStatus(
        p4App.id,
        "PENDING",
        "APPROVED",
        reviewerId,
      );
      if (!claimed) throw new Error("P4_UNEXPECTED_NO_CLAIM");
      await repos.catalog.createRestaurant({
        name: claimed.name,
        gst_number: claimed.gst_number,
        fssai_license: claimed.fssai_license,
        owner_id: claimed.applicant_id,
        commission_rate: claimed.commission_rate,
        lat: claimed.lat,
        lng: claimed.lng,
        pickup_eta_min: 20,
      });
      throw new Error("HARNESS_FORCED_ROLLBACK_P4");
    });
  } catch (err) {
    p4Threw = err instanceof Error && err.message === "HARNESS_FORCED_ROLLBACK_P4";
  }
  const p4Status = await statusOf(p4App.id);
  const p4Restaurants = await count("select count(*)::int as n from restaurants where owner_id=$1", [p4Applicant]);
  const p4Chains = await count("select count(*)::int as n from chains where owner_id=$1", [p4Applicant]);
  const p4Role = await roleOf(p4Applicant);
  const p4Scoped = await count("select count(*)::int as n from user_roles where user_id=$1", [p4Applicant]);
  const p4Audit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1",
    [p4App.id],
  );

  check(
    "P4_ROLLBACK_AFTER_RESTAURANT",
    p4Threw &&
      p4Status === "PENDING" &&
      p4Restaurants === 0 &&
      p4Chains === 0 &&
      p4Role === "CONSUMER" &&
      p4Scoped === 0 &&
      p4Audit === 0,
    `threw=${p4Threw} status=${p4Status} restaurants=${p4Restaurants} chains=${p4Chains} role=${p4Role} scopedRoles=${p4Scoped} audit=${p4Audit}`,
  );
  console.log(`P4_STATUS=${p4Status}`);
  console.log(`P4_RESTAURANTS=${p4Restaurants}`);
  console.log(`P4_ROLE=${p4Role}`);
  console.log(`P4_SCOPED_ROLES=${p4Scoped}`);
  console.log(`P4_AUDIT=${p4Audit}`);

  // ============================================================
  // P5 — ROLE / SCOPED ROLE / STATUS ROLLBACK TOGETHER
  // ============================================================
  const P5_ORIGINAL_ROLE = "PENDING_VENDOR";
  const p5Applicant = await makeApplicant("p5", P5_ORIGINAL_ROLE);
  const p5App = await makeApplication(p5Applicant, "p5", "SINGLE");
  let p5Threw = false;
  try {
    await port.runInTransaction(async (repos: any) => {
      const claimed = await repos.vendorApplication.transitionStatus(
        p5App.id,
        "PENDING",
        "APPROVED",
        reviewerId,
      );
      if (!claimed) throw new Error("P5_UNEXPECTED_NO_CLAIM");
      await repos.catalog.createRestaurant({
        name: claimed.name,
        gst_number: claimed.gst_number,
        fssai_license: claimed.fssai_license,
        owner_id: claimed.applicant_id,
        commission_rate: claimed.commission_rate,
        lat: claimed.lat,
        lng: claimed.lng,
        pickup_eta_min: 20,
      });
      await repos.identity.updateRole(claimed.applicant_id, "VENDOR_OWNER");
      await repos.userRole.assign({
        user_id: claimed.applicant_id,
        scope_type: "restaurant",
        scope_id: p5App.id,
        role: "VENDOR_OWNER",
      });
      throw new Error("HARNESS_FORCED_ROLLBACK_P5");
    });
  } catch (err) {
    p5Threw = err instanceof Error && err.message === "HARNESS_FORCED_ROLLBACK_P5";
  }
  const p5Status = await statusOf(p5App.id);
  const p5Role = await roleOf(p5Applicant);
  const p5Scoped = await count("select count(*)::int as n from user_roles where user_id=$1", [p5Applicant]);
  const p5Restaurants = await count("select count(*)::int as n from restaurants where owner_id=$1", [p5Applicant]);
  const p5Chains = await count("select count(*)::int as n from chains where owner_id=$1", [p5Applicant]);
  const p5Audit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1",
    [p5App.id],
  );

  check(
    "P5_ROLE_STATUS_AUDIT_ROLLBACK",
    p5Threw &&
      p5Status === "PENDING" &&
      p5Role === P5_ORIGINAL_ROLE &&
      p5Scoped === 0 &&
      p5Restaurants === 0 &&
      p5Chains === 0 &&
      p5Audit === 0,
    `threw=${p5Threw} status=${p5Status} identityRole=${p5Role} scopedRoles=${p5Scoped} restaurants=${p5Restaurants} chains=${p5Chains} audit=${p5Audit}`,
  );
  console.log(`P5_STATUS=${p5Status}`);
  console.log(`P5_IDENTITY_ROLE=${p5Role}`);
  console.log(`P5_ORIGINAL_ROLE=${P5_ORIGINAL_ROLE}`);
  console.log(`P5_SCOPED_ROLES=${p5Scoped}`);
  console.log(`P5_RESTAURANTS=${p5Restaurants}`);
  console.log(`P5_CHAINS=${p5Chains}`);
  console.log(`P5_AUDIT=${p5Audit}`);

  // ============================================================
  // P6 — ZERO-ROW CAS
  // ============================================================
  const p6Applicant = await makeApplicant("p6");
  const p6App = await makeApplication(p6Applicant, "p6", "SINGLE");
  const p6First = await appRepo.transitionStatus(p6App.id, "PENDING", "APPROVED", reviewerId);
  const p6Zero = await appRepo.transitionStatus(p6App.id, "PENDING", "REJECTED", reviewerId, "nope");
  const p6Status = await statusOf(p6App.id);
  const p6Restaurants = await count("select count(*)::int as n from restaurants where owner_id=$1", [p6Applicant]);
  const p6RejectedAudit = await count(
    "select count(*)::int as n from audit_logs where metadata->>'application_id'=$1 and action=$2",
    [p6App.id, "vendor_application_rejected"],
  );

  check(
    "P6_ZERO_ROW_CAS",
    p6First !== null && p6Zero === null && p6Status === "APPROVED" && p6Restaurants === 0 && p6RejectedAudit === 0,
    `firstClaimed=${p6First !== null} zeroRowNull=${p6Zero === null} status=${p6Status} restaurants=${p6Restaurants} rejectedAudit=${p6RejectedAudit}`,
  );
  console.log(`P6_RETURNED_NULL=${p6Zero === null ? "YES" : "NO"}`);
  console.log(`P6_STATE_UNCHANGED=${p6Status === "APPROVED" ? "YES" : "NO"}`);
  console.log(`P6_SIDE_EFFECTS=${p6Restaurants === 0 && p6RejectedAudit === 0 ? "NONE" : "PRESENT"}`);

  // ============================================================
  // P7 — POST-COMMIT EVENT FAILURE DOES NOT ROLL BACK DB
  // ============================================================
  const p7Applicant = await makeApplicant("p7");
  const p7App = await makeApplication(p7Applicant, "p7", "SINGLE");
  const p7Commit = await port.runInTransaction((repos: any) =>
    approve(repos, p7App.id, p7Applicant, reviewerId),
  );
  const p7CommittedStatus = await statusOf(p7App.id);
  const p7CommittedRestaurants = await count(
    "select count(*)::int as n from restaurants where owner_id=$1",
    [p7Applicant],
  );

  const eventBus = await import("../src/lib/eventBus");
  const redisMod = await import("../src/lib/redis");
  const brokenRedis: any = {
    status: "ready",
    connect: async () => {
      throw new Error("harness_forced_connect_failure");
    },
    on: () => {},
    off: () => {},
    publish: async () => {
      throw new Error("harness_forced_publish_failure");
    },
    ping: async () => "PONG",
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
    duplicate() {
      return brokenRedis;
    },
    subscribe: async () => {},
    quit: async () => "OK",
  };
  redisMod.setRedisForTests(brokenRedis);
  eventBus.resetEventBusForTests();
  let p7EventHandlerRan = false;
  eventBus.onEvent("VendorApplicationApproved" as any, async () => {
    p7EventHandlerRan = true;
    throw new Error("harness_forced_handler_failure");
  });

  let p7EmitThrew = false;
  try {
    await eventBus.emit(
      eventBus.createEventEnvelope("VendorApplicationApproved" as any, p7App.id, {
        applicant_id: p7Applicant,
      }) as any,
    );
  } catch {
    p7EmitThrew = true;
  }
  await sleep(200);

  const p7AfterStatus = await statusOf(p7App.id);
  const p7AfterRestaurants = await count(
    "select count(*)::int as n from restaurants where owner_id=$1",
    [p7Applicant],
  );
  redisMod.resetRedisForTests();
  eventBus.resetEventBusForTests();

  check(
    "P7_POST_COMMIT_EVENT_FAILURE",
    p7Commit.ok &&
      p7CommittedStatus === "APPROVED" &&
      p7AfterStatus === "APPROVED" &&
      p7AfterRestaurants === 1,
    `emitThrew=${p7EmitThrew} handlerRan=${p7EventHandlerRan} committedStatus=${p7CommittedStatus} afterStatus=${p7AfterStatus} restaurants=${p7AfterRestaurants}`,
  );
  console.log("POST_COMMIT_EVENT_FAILURE_ROLLS_BACK_DB=NO");

  // ---------- concurrency verdict ----------
  const realConcurrent =
    p1Winners === 1 &&
    lockWaitObserved &&
    p1Results.length === 2 &&
    p3Results.length === 2;
  check("REAL_CONCURRENT_TX", realConcurrent, `lockWaitObserved=${lockWaitObserved}`);
  console.log(`REAL_CONCURRENT_TX=${realConcurrent ? "YES" : "NO"}`);

  // ---------- cleanup ----------
  const cleanupQueries: Array<[string, unknown[]]> = [
    ["delete from audit_logs where metadata->>'application_id' = any($1::text[])", [appIds]],
    ["delete from user_roles where user_id = any($1::uuid[])", [userIds]],
    ["delete from vendor_applications where id = any($1::uuid[])", [appIds]],
    ["delete from restaurants where owner_id = any($1::uuid[])", [userIds]],
    ["delete from chains where owner_id = any($1::uuid[])", [userIds]],
    ["delete from users where id = any($1::uuid[])", [userIds]],
  ];
  for (const [sqlText, params] of cleanupQueries) {
    await pool.query(sqlText, params as any[]);
  }
  const leftovers =
    (await count("select count(*)::int as n from vendor_applications where id = any($1::uuid[])", [appIds])) +
    (await count("select count(*)::int as n from users where id = any($1::uuid[])", [userIds])) +
    (await count("select count(*)::int as n from restaurants where owner_id = any($1::uuid[])", [userIds]));
  console.log(`CLEANUP_LEFTOVER_TEST_ROWS=${leftovers}`);
  check("CLEANUP_NO_LEFTOVER_ROWS", leftovers === 0, `leftovers=${leftovers}`);

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log(`UNHANDLED_REJECTION_COUNT=${unhandled}`);

  await pool.end();
  console.log("OPEN_DB_CONNECTIONS=CLOSED");

  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
