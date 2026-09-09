import { describe, expect, it, beforeEach } from "vitest";
import { support_tickets } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";
import { MemorySupportRepository } from "./supportRepository";
import { DrizzleSupportRepository } from "./drizzle/drizzleSupportRepository";

// ============================================
// Support repository parity tests.
//
// Proves MemorySupportRepository and DrizzleSupportRepository expose the
// SAME observable behavior for every listed contract method (create,
// getById, findByUser, listAll ordering/filters/pagination/total, update).
//
// The Drizzle half runs against the lightweight in-memory DrizzleDb stand-in
// used by chainRepository.test.ts (no live Postgres needed in the unit
// suite). Real-Postgres durability is proven separately by the integration
// harness apps/api/integration/realPgSupportPersistence.ts.
// ============================================

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ffff";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================
// In-memory stand-in for the DrizzleDb facade (select/insert/update/delete/
// transaction) that parses eq()/and() conditions built by drizzle-orm so
// the real repository code path (SQL AST -> predicate) is exercised.
// ============================================

function createFakeDb(): { db: DrizzleDb; rowsFor: (table: unknown) => Record<string, unknown>[] } {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  function collectPairs(cond: unknown, out: Array<{ col: string; val: unknown }>): void {
    if (!cond || typeof cond !== "object") return;
    const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;

    for (const chunk of chunks) {
      const c = chunk as { queryChunks?: unknown[] } | null;
      if (c && typeof c === "object" && Array.isArray(c.queryChunks)) {
        collectPairs(c, out);
      }
    }

    let col: string | undefined;
    let val: unknown;
    let hasParam = false;
    for (const chunk of chunks) {
      const c = chunk as { name?: unknown; value?: unknown; encoder?: unknown } | null;
      if (!c || typeof c !== "object") continue;
      if (typeof c.name === "string" && col === undefined) col = c.name;
      if ("encoder" in c) {
        val = c.value;
        hasParam = true;
      }
    }
    if (col !== undefined && hasParam) out.push({ col, val });
  }

  const predicateFrom = (cond: unknown): ((row: Record<string, unknown>) => boolean) => {
    if (cond == null) return () => true;
    const pairs: Array<{ col: string; val: unknown }> = [];
    collectPairs(cond, pairs);
    return (row) => pairs.every(({ col, val }) => row[col] === val);
  };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async (cond?: unknown): Promise<Record<string, unknown>[]> => {
          const pred = predicateFrom(cond);
          return rowsFor(table).filter(pred);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        const row = { created_at: new Date(), ...values };
        rowsFor(table).push(row);
        return [row];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (cond?: unknown) => {
          const pred = predicateFrom(cond);
          const matched = rowsFor(table).filter(pred);
          matched.forEach((r) => Object.assign(r, values));
          return matched;
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond?: unknown) => {
        const pred = predicateFrom(cond);
        const matched = rowsFor(table).filter(pred);
        tables.set(table, rowsFor(table).filter((r) => !pred(r)));
        return matched;
      },
    }),
    transaction: async <T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> =>
      fn(db as unknown as DrizzleDb),
  };

  return { db: db as unknown as DrizzleDb, rowsFor };
}

// ============================================
// Shared semantic scenario run against BOTH repositories.
// ============================================

async function seedScenario(repo: MemorySupportRepository | DrizzleSupportRepository) {
  const t1 = await repo.create({
    user_id: USER_A,
    subject: "Alpha problem",
    description: "first ticket",
    priority: "HIGH",
    assignee: null,
  });
  await sleep(3);
  const t2 = await repo.create({
    user_id: USER_A,
    subject: "Beta problem",
    description: "second ticket",
    priority: "LOW",
    assignee: "OPS_AGENT",
  });
  await sleep(3);
  const t3 = await repo.create({
    user_id: USER_B,
    subject: "Gamma problem",
    description: "third ticket",
    priority: "MEDIUM",
    assignee: null,
  });
  return { t1, t2, t3 };
}

function expectValidTicket(ticket: { created_at: string; updated_at: string }): void {
  expect(Number.isNaN(Date.parse(ticket.created_at))).toBe(false);
  expect(Number.isNaN(Date.parse(ticket.updated_at))).toBe(false);
}

async function assertSharedSemantics(
  repo: MemorySupportRepository | DrizzleSupportRepository,
): Promise<void> {
  const { t1, t2, t3 } = await seedScenario(repo);

  // create -> getById round-trip preserves every domain field.
  const readBack = await repo.getById(t2.id);
  expect(readBack).not.toBeNull();
  expect(readBack!.user_id).toBe(USER_A);
  expect(readBack!.subject).toBe("Beta problem");
  expect(readBack!.description).toBe("second ticket");
  expect(readBack!.priority).toBe("LOW");
  expect(readBack!.status).toBe("OPEN");
  expect(readBack!.assignee).toBe("OPS_AGENT");
  expectValidTicket(readBack!);

  expect(await repo.getById(UNKNOWN_ID)).toBeNull();

  // findByUser: only that user's tickets, newest first.
  expect((await repo.findByUser(USER_A)).map((t) => t.id)).toEqual([t2.id, t1.id]);
  expect((await repo.findByUser(USER_B)).map((t) => t.id)).toEqual([t3.id]);
  expect(await repo.findByUser("00000000-0000-4000-8000-0000000000ffff")).toEqual([]);

  // listAll default ordering: created_at DESC.
  expect((await repo.listAll({ page: 1, limit: 10 })).items.map((t) => t.id)).toEqual([
    t3.id,
    t2.id,
    t1.id,
  ]);

  // Move t2 out of OPEN so status filters are discriminative.
  const preUpdate = await repo.update(t2.id, { status: "IN_PROGRESS" });
  expect(preUpdate!.status).toBe("IN_PROGRESS");

  // listAll status filter.
  expect((await repo.listAll({ page: 1, limit: 10, status: "OPEN" })).items.map((t) => t.id)).toEqual([
    t3.id,
    t1.id,
  ]);
  expect((await repo.listAll({ page: 1, limit: 10, status: "IN_PROGRESS" })).items.map((t) => t.id)).toEqual([
    t2.id,
  ]);
  expect((await repo.listAll({ page: 1, limit: 10, status: "RESOLVED" })).items).toEqual([]);

  // listAll priority filter.
  expect((await repo.listAll({ page: 1, limit: 10, priority: "HIGH" })).items.map((t) => t.id)).toEqual([
    t1.id,
  ]);
  expect((await repo.listAll({ page: 1, limit: 10, priority: "MEDIUM" })).items.map((t) => t.id)).toEqual([
    t3.id,
  ]);
  expect((await repo.listAll({ page: 1, limit: 10, priority: "HIGH", status: "OPEN" })).items.map((t) => t.id)).toEqual([
    t1.id,
  ]);
  expect((await repo.listAll({ page: 1, limit: 10, priority: "HIGH", status: "CLOSED" })).items).toEqual([]);

  // listAll total counts the FILTERED set, not the page slice.
  const all = await repo.listAll({ page: 1, limit: 10 });
  expect(all.total).toBe(3);
  const open = await repo.listAll({ page: 1, limit: 10, status: "OPEN" });
  expect(open.total).toBe(2);
  const high = await repo.listAll({ page: 1, limit: 10, priority: "HIGH" });
  expect(high.total).toBe(1);

  // listAll pagination: offset = (page-1)*limit over the filtered set.
  const page1 = await repo.listAll({ page: 1, limit: 2 });
  expect(page1.items.map((t) => t.id)).toEqual([t3.id, t2.id]);
  expect(page1.total).toBe(3);
  const page2 = await repo.listAll({ page: 2, limit: 2 });
  expect(page2.items.map((t) => t.id)).toEqual([t1.id]);
  expect(page2.total).toBe(3);
  const page3 = await repo.listAll({ page: 3, limit: 2 });
  expect(page3.items).toEqual([]);

  // update: status only, assignee only, both.
  const beforeUpdated = Date.parse((await repo.getById(t2.id))!.updated_at);
  const updatedStatus = await repo.update(t2.id, { status: "IN_PROGRESS" });
  expect(updatedStatus!.status).toBe("IN_PROGRESS");
  expect(updatedStatus!.assignee).toBe("OPS_AGENT");
  expect(Date.parse(updatedStatus!.updated_at)).toBeGreaterThanOrEqual(beforeUpdated);
  expect((await repo.getById(t2.id))!.status).toBe("IN_PROGRESS");

  const updatedAssignee = await repo.update(t2.id, { assignee: "TIER_2_AGENT" });
  expect(updatedAssignee!.status).toBe("IN_PROGRESS");
  expect(updatedAssignee!.assignee).toBe("TIER_2_AGENT");
  expect((await repo.getById(t2.id))!.assignee).toBe("TIER_2_AGENT");

  const combined = await repo.update(t2.id, { status: "CLOSED", assignee: "OPS_AGENT" });
  expect(combined!.status).toBe("CLOSED");
  expect(combined!.assignee).toBe("OPS_AGENT");
  const after = await repo.getById(t2.id);
  expect(after!.status).toBe("CLOSED");
  expect(after!.assignee).toBe("OPS_AGENT");
  expectValidTicket(after!);

  // listAll reflects updates through the filter.
  const closed = await repo.listAll({ page: 1, limit: 10, status: "CLOSED" });
  expect(closed.items.map((t) => t.id)).toEqual([t2.id]);
  expect(closed.total).toBe(1);

  // update unknown id -> null.
  expect(await repo.update(UNKNOWN_ID, { status: "CLOSED" })).toBeNull();
  expect(await repo.update(UNKNOWN_ID, { assignee: "OPS_AGENT" })).toBeNull();
}

// ============================================
// Memory repository is the reference semantics.
// ============================================

describe("MemorySupportRepository semantics", () => {
  let repo: MemorySupportRepository;

  beforeEach(() => {
    repo = new MemorySupportRepository();
  });

  it("create returns an OPEN ticket with OPEN defaults and null assignee", async () => {
    const ticket = await repo.create({
      user_id: USER_A,
      subject: "Spicy order issue",
      description: "Missing chutney",
      priority: "HIGH",
      assignee: null,
    });
    expect(ticket.id).toBeTruthy();
    expect(ticket.status).toBe("OPEN");
    expect(ticket.assignee).toBeNull();
    expect(ticket.user_id).toBe(USER_A);
    expectValidTicket(ticket);
  });

  it("matches the full shared semantic contract", async () => {
    await assertSharedSemantics(repo);
  });
});

// ============================================
// Drizzle repository exposes identical behavior through the SQL facade.
// ============================================

describe("DrizzleSupportRepository (Postgres-mode facade) semantics", () => {
  let fake: { db: DrizzleDb; rowsFor: (table: unknown) => Record<string, unknown>[] };
  let repo: DrizzleSupportRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzleSupportRepository(fake.db);
  });

  it("create inserts a support_tickets row and returns the OPEN ticket", async () => {
    const ticket = await repo.create({
      user_id: USER_A,
      subject: "Spicy order issue",
      description: "Missing chutney",
      priority: "HIGH",
      assignee: null,
    });
    expect(ticket.status).toBe("OPEN");
    expect(ticket.assignee).toBeNull();
    expectValidTicket(ticket);

    const rows = fake.rowsFor(support_tickets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ticket.id);
    expect(rows[0]!.user_id).toBe(USER_A);
    expect(rows[0]!.subject).toBe("Spicy order issue");
    expect(rows[0]!.status).toBe("OPEN");
  });

  it("maps the assigned_to DB column to the domain assignee field", async () => {
    const ticket = await repo.create({
      user_id: USER_A,
      subject: "Vendor question",
      description: "How do I get paid",
      priority: "MEDIUM",
      assignee: "OPS_AGENT",
    });
    const row = fake.rowsFor(support_tickets)[0]!;
    expect(row.assigned_to).toBe("OPS_AGENT");
    expect(ticket.assignee).toBe("OPS_AGENT");
    expect((ticket as unknown as Record<string, unknown>).assigned_to).toBeUndefined();

    const read = await repo.getById(ticket.id);
    expect(read!.assignee).toBe("OPS_AGENT");
  });

  it("matches the full shared semantic contract", async () => {
    await assertSharedSemantics(repo);
  });
});

// ============================================
// Cross-store parity: identical seeds produce identical observable results.
// ============================================

describe("Support repository Memory <-> Drizzle parity", () => {
  it("both stores produce identical listAll/filter/pagination/update outcomes", async () => {
    const memory = new MemorySupportRepository();
    const drizzle = new DrizzleSupportRepository(createFakeDb().db);

    const memTickets = await seedScenario(memory);
    const drizTickets = await seedScenario(drizzle);

    const subjects = (tickets: { subject: string }[]) => tickets.map((t) => t.subject);

    // Full listing: same ordering by subject (created_at DESC both sides).
    expect(subjects((await memory.listAll({ page: 1, limit: 10 })).items)).toEqual(
      subjects((await drizzle.listAll({ page: 1, limit: 10 })).items),
    );

    // Filtered + paginated listing: same pages and totals.
    for (const params of [
      { page: 1, limit: 2 },
      { page: 2, limit: 2 },
      { page: 1, limit: 10, status: "OPEN" as const },
      { page: 2, limit: 1, status: "OPEN" as const },
      { page: 1, limit: 10, priority: "HIGH" as const },
      { page: 1, limit: 10, status: "OPEN" as const, priority: "HIGH" as const },
    ]) {
      const mem = await memory.listAll(params);
      const driz = await drizzle.listAll(params);
      expect(mem.total).toBe(driz.total);
      expect(subjects(mem.items)).toEqual(subjects(driz.items));
    }

    // findByUser: same subjects in same order.
    expect(subjects(await memory.findByUser(USER_A))).toEqual(subjects(await drizzle.findByUser(USER_A)));
    expect(subjects(await memory.findByUser(USER_B))).toEqual(subjects(await drizzle.findByUser(USER_B)));

    // getById unknown id -> null on both.
    expect(await memory.getById(UNKNOWN_ID)).toBeNull();
    expect(await drizzle.getById(UNKNOWN_ID)).toBeNull();

    // update: same resulting status/assignee, same unknown-id null behavior.
    const memUpd = await memory.update(memTickets.t1.id, { status: "RESOLVED", assignee: "TIER_2_AGENT" });
    const drizUpd = await drizzle.update(drizTickets.t1.id, { status: "RESOLVED", assignee: "TIER_2_AGENT" });
    expect(memUpd!.status).toBe(drizUpd!.status);
    expect(memUpd!.assignee).toBe(drizUpd!.assignee);
    expect((await memory.getById(memTickets.t1.id))!.subject).toBe(
      (await drizzle.getById(drizTickets.t1.id))!.subject,
    );
    expect(await memory.update(UNKNOWN_ID, { status: "CLOSED" })).toBeNull();
    expect(await drizzle.update(UNKNOWN_ID, { status: "CLOSED" })).toBeNull();
  });
});
