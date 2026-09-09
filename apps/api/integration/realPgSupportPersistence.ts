// ============================================================
// SUPPORT-PERSISTENCE-A2 — REAL-POSTGRES DURABILITY PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a
// non-test NODE_ENV against a disposable, already-migrated DATABASE_URL
// (the support_tickets table + enums must exist):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://a2_support_proof:<pw>@127.0.0.1:5432/a2_support_proof \
//   pnpm exec tsx apps/api/integration/realPgSupportPersistence.ts
//
// PROVES (and only claims) the DrizzleSupportRepository persists through
// REAL PostgreSQL across independent connections:
//   (1) create writes a support_tickets row (OPEN default, null assignee)
//       readable via getById / findByUser / listAll on the same pool.
//   (2) closing the pool and recreating the repository over a fresh
//       connection still reads the ticket (durability across restart).
//   (3) update(status/assignee) is persisted and readable back immediately.
//   (4) closing the pool again and reading via yet another fresh
//       connection still returns the updated status/assignee.
//   (5) the assigned_to column round-trips into the domain `assignee` field.
//
// Memory-parity alone is not a durability proof; this harness connects to
// the real table. The disposable row is left in the disposable DB (no
// destructive cleanup by design).
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DrizzleSupportRepository } from "../src/repositories/drizzle/drizzleSupportRepository";
import type { DrizzleDb } from "../src/lib/dbType";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at a disposable, migrated DB)");
  process.exit(2);
}
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

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(url)}`);
  console.log("A2 real-PG support persistence proof starting...");

  const userId = randomUUID();
  const subject = `A2 durability ${randomUUID()}`;
  let ticketId: string;
  let createdAt: string;

  // ---------- Connection epoch 1: create + read ----------
  const poolA = new Pool({ connectionString: url, max: 1 });
  const dbA = drizzle(poolA) as unknown as DrizzleDb;
  const repoA = new DrizzleSupportRepository(dbA);
  try {
    const created = await repoA.create({
      user_id: userId,
      subject,
      description: "A2 real-PG durability proof ticket",
      priority: "HIGH",
      assignee: null,
    });
    ticketId = created.id;
    createdAt = created.created_at;
    console.log(`[epoch1] create -> id=${ticketId} status=${created.status} assignee=${created.assignee}`);

    const byId = await repoA.getById(ticketId);
    if (!byId || byId.id !== ticketId) throw new Error("epoch1: getById missing ticket");
    console.log(`[epoch1] getById OK (subject='${byId.subject}', priority=${byId.priority})`);

    const byUser = await repoA.findByUser(userId);
    if (!byUser.some((t) => t.id === ticketId)) throw new Error("epoch1: findByUser missing ticket");
    console.log(`[epoch1] findByUser OK (${byUser.length} ticket(s) for user)`);

    const listing = await repoA.listAll({ page: 1, limit: 50, priority: "HIGH" });
    if (!listing.items.some((t) => t.id === ticketId)) throw new Error("epoch1: listAll missing ticket");
    console.log(`[epoch1] listAll OK (total=${listing.total} filtered by priority=HIGH)`);
  } finally {
    await poolA.end();
  }

  // ---------- Connection epoch 2: durability across a fresh pool ----------
  const poolB = new Pool({ connectionString: url, max: 1 });
  const dbB = drizzle(poolB) as unknown as DrizzleDb;
  const repoB = new DrizzleSupportRepository(dbB);
  try {
    const reloaded = await repoB.getById(ticketId);
    if (!reloaded) throw new Error("epoch2: ticket lost after pool/connection restart");
    if (reloaded.created_at !== createdAt) {
      throw new Error(`epoch2: created_at changed across restart (${reloaded.created_at} vs ${createdAt})`);
    }
    console.log(`[epoch2] getById OK after connection restart (status=${reloaded.status}, assignee=${reloaded.assignee})`);

    const updated = await repoB.update(ticketId, { status: "IN_PROGRESS", assignee: "OPS_AGENT" });
    if (!updated || updated.status !== "IN_PROGRESS" || updated.assignee !== "OPS_AGENT") {
      throw new Error("epoch2: update did not return IN_PROGRESS/OPS_AGENT");
    }
    const reRead = await repoB.getById(ticketId);
    if (!reRead || reRead.status !== "IN_PROGRESS" || reRead.assignee !== "OPS_AGENT") {
      throw new Error("epoch2: updated status/assignee not readable in same epoch");
    }
    console.log(`[epoch2] update(status=IN_PROGRESS, assignee=OPS_AGENT) OK; updated_at=${reRead.updated_at}`);
  } finally {
    await poolB.end();
  }

  // ---------- Connection epoch 3: update survived a second restart ----------
  const poolC = new Pool({ connectionString: url, max: 1 });
  const dbC = drizzle(poolC) as unknown as DrizzleDb;
  const repoC = new DrizzleSupportRepository(dbC);
  try {
    const final = await repoC.getById(ticketId);
    if (!final) throw new Error("epoch3: ticket lost after second restart");
    if (final.status !== "IN_PROGRESS") throw new Error("epoch3: status update not durable");
    if (final.assignee !== "OPS_AGENT") throw new Error("epoch3: assignee update not durable");
    if (final.assigned_to !== undefined) throw new Error("epoch3: domain field leaked DB column name");
    console.log(`[epoch3] getById OK after second restart (status=${final.status}, assignee=${final.assignee})`);
    console.log(`[epoch3] assigned_to -> assignee mapping OK`);
  } finally {
    await poolC.end();
  }

  console.log("A2 REAL-PG SUPPORT PERSISTENCE PROOF PASSED");
  console.log(`A2 ticket kept in disposable DB for manual inspection: id=${ticketId}`);
}

main().catch((err) => {
  console.error("A2 REAL-PG SUPPORT PERSISTENCE FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
