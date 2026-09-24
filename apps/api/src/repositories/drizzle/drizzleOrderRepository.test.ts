import { beforeEach, describe, expect, it } from "vitest";
import { orders } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";

// ============================================
// DrizzleOrderRepository check-in persistence (CONSUMER_PICKUP_TRUTH-W2A).
//
// Runs the REAL DrizzleOrderRepository code path against the lightweight
// in-memory DrizzleDb stand-in used by chainRepository.test.ts /
// supportRepository.parity.test.ts (select/insert/update incl. .returning(),
// eq()/and() AST -> predicate). No live Postgres needed here; real-Postgres
// durability is proven separately by the integration harness.
//
// The discriminating assertion is P3: after setCheckedIn, a FRESH repository
// reread must observe checked_in=true. The former implementation only touched
// updated_at and mutated the returned DTO, so P3 failed (fresh reread false).
// ============================================

const OID = "11111111-1111-4111-8111-111111111111";
const MISSING = "99999999-9999-4999-8999-999999999999";

interface FakeDb {
  db: DrizzleDb;
  rowsFor: (table: unknown) => Record<string, unknown>[];
}

function createFakeDb(): FakeDb {
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
        where: async (cond?: unknown): Promise<Record<string, unknown>[]> =>
          rowsFor(table).filter(predicateFrom(cond)),
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
        where: (cond?: unknown) => {
          const pred = predicateFrom(cond);
          let applied: Record<string, unknown>[] | null = null;
          const run = (): Record<string, unknown>[] => {
            if (applied) return applied;
            const matched = rowsFor(table).filter(pred);
            matched.forEach((r) => Object.assign(r, values));
            applied = matched;
            return applied;
          };
          return {
            then: (
              resolve: (rows: Record<string, unknown>[]) => unknown,
              reject?: (err: unknown) => unknown,
            ) => Promise.resolve(run()).then(resolve, reject),
            returning: () => Promise.resolve(run()),
          };
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

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: OID,
    user_id: "22222222-2222-4222-8222-222222222222",
    restaurant_id: "33333333-3333-4333-8333-333333333333",
    total_amount: "100.00",
    status: "CONFIRMED",
    commission_rate: "0.08",
    commission_amount: "8.00",
    is_catering: false,
    headcount: null,
    pickup_otp: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("DrizzleOrderRepository check-in persistence (W2A)", () => {
  let fake: FakeDb;
  let repo: DrizzleOrderRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzleOrderRepository(fake.db);
  });

  it("P1 maps a persisted checked_in=true row to DTO true", async () => {
    fake.rowsFor(orders).push(orderRow({ checked_in: true }));

    const dto = await repo.getById(OID);
    expect(dto?.checked_in).toBe(true);
  });

  it("P2 setCheckedIn CAS false->true returns true and persists into the row", async () => {
    fake.rowsFor(orders).push(orderRow({ checked_in: false }));

    const out = await repo.setCheckedIn(OID);
    expect(out?.checked_in).toBe(true);
    expect(fake.rowsFor(orders)[0]!.checked_in).toBe(true);
  });

  it("P3 fresh repository reread after setCheckedIn returns true (durable truth)", async () => {
    fake.rowsFor(orders).push(orderRow({ checked_in: false }));
    await repo.setCheckedIn(OID);

    const fresh = await repo.getById(OID);
    expect(fresh?.checked_in).toBe(true);
  });

  it("P4 already-true row is idempotent success and takes the CAS-miss path (no rewrite)", async () => {
    fake.rowsFor(orders).push(orderRow({ checked_in: true }));
    const updatedAtBefore = fake.rowsFor(orders)[0]!.updated_at;

    const out = await repo.setCheckedIn(OID);
    expect(out?.checked_in).toBe(true);
    // CAS predicate includes checked_in=false, so an already-true row must not
    // be rewritten (updated_at unchanged).
    expect(fake.rowsFor(orders)[0]!.updated_at).toBe(updatedAtBefore);
  });

  it("P5 setCheckedIn on a missing row returns null", async () => {
    expect(await repo.setCheckedIn(MISSING)).toBeNull();
  });
});
