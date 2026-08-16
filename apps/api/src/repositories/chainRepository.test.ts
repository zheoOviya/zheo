import { beforeEach, describe, expect, it } from "vitest";
import { chains, restaurants } from "@snakzap/db";
import { DrizzleChainRepository } from "./chainRepository";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// DrizzleChainRepository unit tests (Postgres mode)
// Uses a lightweight in-memory stand-in for the DrizzleDb facade that mimics
// the real query-builder surface (select().from().where(), insert, update,
// delete, transaction) so we can assert persistence behavior without a live
// Postgres instance.
// ============================================

const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";

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

  // eq(left, right) builds SQL chunks [StringChunk, Column, StringChunk(" = "), Param, StringChunk].
  // Extract the column name (chunk with `name`) and the bound value (chunk with `encoder`).
  function predicateFrom(cond: unknown): (row: Record<string, unknown>) => boolean {
    if (cond == null) return () => true;
    const chunks = (cond as { queryChunks: unknown[] }).queryChunks;
    let colName: string | undefined;
    let value: unknown;
    for (const chunk of chunks) {
      const c = chunk as { name?: unknown; value?: unknown; encoder?: unknown };
      if (c && typeof c === "object" && typeof c.name === "string" && colName === undefined) {
        colName = c.name;
      }
      if (c && typeof c === "object" && "encoder" in c) {
        value = c.value;
      }
    }
    return (row) => colName !== undefined && row[colName] === value;
  }

  function query(table: unknown, cond?: unknown): Promise<Record<string, unknown>[]> & { where: (c?: unknown) => Promise<Record<string, unknown>[]> } {
    const pred = predicateFrom(cond);
    const p = Promise.resolve(rowsFor(table).filter(pred)) as Promise<Record<string, unknown>[]> & { where: (c?: unknown) => Promise<Record<string, unknown>[]> };
    p.where = (c?: unknown) => query(table, c);
    return p;
  }

  const db = {
    select: () => ({ from: (table: unknown) => query(table) }),
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

describe("DrizzleChainRepository (Postgres mode)", () => {
  let fake: FakeDb;
  let repo: DrizzleChainRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzleChainRepository(fake.db);
  });

  it("create inserts a chains row and returns the ChainDTO", async () => {
    const chain = await repo.create("Spice Route", OWNER_ID);

    expect(chain.name).toBe("Spice Route");
    expect(chain.owner_id).toBe(OWNER_ID);
    expect(chain.id).toBeTruthy();

    const rows = fake.rowsFor(chains);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(chain.id);
    expect(rows[0]!.name).toBe("Spice Route");
    expect(rows[0]!.owner_id).toBe(OWNER_ID);
  });

  it("getById and getByOwner and getAll read persisted chains", async () => {
    const a = await repo.create("Alpha Eats", OWNER_ID);
    const b = await repo.create("Beta Bites", OWNER_ID);
    await repo.create("Gamma Grill", "00000000-0000-4000-8000-0000000000b2");

    expect((await repo.getById(a.id))?.name).toBe("Alpha Eats");
    expect(await repo.getById("missing")).toBeNull();

    const owned = await repo.getByOwner(OWNER_ID);
    expect(owned.map((c) => c.name).sort()).toEqual(["Alpha Eats", "Beta Bites"]);

    const all = await repo.getAll();
    expect(all).toHaveLength(3);
    expect(all.some((c) => c.id === b.id)).toBe(true);
  });

  it("resolves outlet ids and outlet chain via restaurants.chain_id FK", async () => {
    const chain = await repo.create("Spice Route", OWNER_ID);

    // Simulate N restaurant rows attached to the chain (the approval path
    // inserts these via the catalog repository).
    fake.rowsFor(restaurants).push(
      { id: "r-outlet-1", name: "Spice Route — Outlet 1", owner_id: OWNER_ID, chain_id: chain.id },
      { id: "r-outlet-2", name: "Spice Route — Outlet 2", owner_id: OWNER_ID, chain_id: chain.id },
      { id: "r-standalone", name: "Standalone", owner_id: OWNER_ID, chain_id: null },
    );

    const outletIds = await repo.getOutletIdsByChain(chain.id);
    expect(outletIds.sort()).toEqual(["r-outlet-1", "r-outlet-2"]);

    expect(await repo.getOutletChainId("r-outlet-1")).toBe(chain.id);
    expect(await repo.getOutletChainId("r-standalone")).toBeNull();
    expect(await repo.getOutletChainId("missing")).toBeNull();
  });
});
