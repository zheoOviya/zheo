import { describe, expect, it, beforeEach } from "vitest";
import { event_consumer_dedup } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";
import {
  MemoryEventConsumerDedupRepository,
  type EventConsumerDedupRepository,
} from "./eventConsumerDedupRepository";
import { DrizzleEventConsumerDedupRepository } from "./drizzle/drizzleEventConsumerDedupRepository";

// ============================================
// EVT-C1 repository parity (C1-5) + composite-PK semantics (C1-7).
//
// The Drizzle half runs against a lightweight in-memory DrizzleDb stand-in that
// enforces the (consumer_name, event_id) PRIMARY KEY via ON CONFLICT DO NOTHING
// semantics. Real-Postgres durability + transaction rollback are proven
// separately by apps/api/integration/realPgEventConsumerDedup.ts.
// ============================================

const CONSUMER_A = "retention.cashback";
const CONSUMER_B = "loyalty.order_stamp";
const EVENT_1 = "11111111-1111-4111-8111-111111111111";
const EVENT_2 = "22222222-2222-4222-8222-222222222222";

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

  function collectPairs(
    cond: unknown,
    out: Array<{ col: string; val: unknown }>,
  ): void {
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
      const c = chunk as
        | { name?: unknown; value?: unknown; encoder?: unknown }
        | null;
      if (!c || typeof c !== "object") continue;
      if (typeof c.name === "string" && col === undefined) col = c.name;
      if ("encoder" in c) {
        val = c.value;
        hasParam = true;
      }
    }
    if (col !== undefined && hasParam) out.push({ col, val });
  }

  const predicateFrom = (
    cond: unknown,
  ): ((row: Record<string, unknown>) => boolean) => {
    if (cond == null) return () => true;
    const pairs: Array<{ col: string; val: unknown }> = [];
    collectPairs(cond, pairs);
    return (row) => pairs.every(({ col, val }) => row[col] === val);
  };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond?: unknown) => {
          const exec = () => rowsFor(table).filter(predicateFrom(cond));
          const p = Promise.resolve().then(exec) as Promise<
            Record<string, unknown>[]
          > & { for: (lock: "update") => Promise<Record<string, unknown>[]> };
          p.for = () => Promise.resolve().then(exec);
          return p;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          const rows = rowsFor(table);
          const exists = rows.some(
            (r) =>
              r.consumer_name === values.consumer_name &&
              r.event_id === values.event_id,
          );
          if (!exists) rows.push({ processed_at: new Date(), ...values });
          return [];
        },
      }),
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
        tables.set(
          table,
          rowsFor(table).filter((r) => !pred(r)),
        );
        return matched;
      },
    }),
    transaction: async <T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> =>
      fn(db as unknown as DrizzleDb),
  };

  return { db: db as unknown as DrizzleDb, rowsFor };
}

async function assertSharedSemantics(
  repo: EventConsumerDedupRepository,
): Promise<void> {
  // C1-1 first insert succeeds.
  expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(false);
  await repo.markProcessed(CONSUMER_A, EVENT_1);
  expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);

  // C1-2 duplicate pair is a no-op (no second marker, no throw).
  await repo.markProcessed(CONSUMER_A, EVENT_1);

  // C1-3 same event_id + different consumer allowed.
  await repo.markProcessed(CONSUMER_B, EVENT_1);
  expect(await repo.hasProcessed(CONSUMER_B, EVENT_1)).toBe(true);

  // C1-4 same consumer + different event_id allowed.
  await repo.markProcessed(CONSUMER_A, EVENT_2);
  expect(await repo.hasProcessed(CONSUMER_A, EVENT_2)).toBe(true);
}

describe("EVT-C1 repository parity", () => {
  let fake: FakeDb;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it("Memory matches the shared semantics", async () => {
    const repo = new MemoryEventConsumerDedupRepository();
    await assertSharedSemantics(repo);
    expect(repo._all()).toHaveLength(3);
  });

  it("Drizzle matches the shared semantics and the composite PK (C1-7)", async () => {
    const repo = new DrizzleEventConsumerDedupRepository(fake.db);
    await assertSharedSemantics(repo);
    expect(fake.rowsFor(event_consumer_dedup)).toHaveLength(3);
  });

  it("C1-5 Memory and Drizzle observe identical hasProcessed results", async () => {
    const memory = new MemoryEventConsumerDedupRepository();
    const drizzle = new DrizzleEventConsumerDedupRepository(fake.db);

    expect(await memory.hasProcessed(CONSUMER_A, EVENT_1)).toBe(
      await drizzle.hasProcessed(CONSUMER_A, EVENT_1),
    );

    for (const [consumer, event] of [
      [CONSUMER_A, EVENT_1],
      [CONSUMER_A, EVENT_1],
      [CONSUMER_B, EVENT_1],
      [CONSUMER_A, EVENT_2],
      [CONSUMER_B, EVENT_2],
    ] as const) {
      await memory.markProcessed(consumer, event);
      await drizzle.markProcessed(consumer, event);
    }

    for (const consumer of [CONSUMER_A, CONSUMER_B]) {
      for (const event of [EVENT_1, EVENT_2]) {
        expect(await memory.hasProcessed(consumer, event)).toBe(
          await drizzle.hasProcessed(consumer, event),
        );
      }
    }
    expect(memory._all()).toHaveLength(4);
    expect(fake.rowsFor(event_consumer_dedup)).toHaveLength(4);
  });

  it("C1-7 Drizzle does not create a second row for a duplicate pair", async () => {
    const repo = new DrizzleEventConsumerDedupRepository(fake.db);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    expect(fake.rowsFor(event_consumer_dedup)).toHaveLength(1);
  });

  it("Drizzle _reset is a no-op (DB-backed)", async () => {
    const repo = new DrizzleEventConsumerDedupRepository(fake.db);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    repo._reset();
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);
  });
});
