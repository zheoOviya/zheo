import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { chains, restaurants } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// Multi-outlet organization repository (V15, Phase 4)
// Vendor-ops bounded context. A Chain groups restaurant outlets under one
// owner; each outlet is a restaurant row attached via chain_id.
// ============================================

export interface ChainDTO {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

export interface ChainRepository {
  getById(chainId: string): Promise<ChainDTO | null>;
  /** Chains owned by a user (Chain Owner scope). */
  getByOwner(ownerId: string): Promise<ChainDTO[]>;
  /** All chains (ADMIN / SUPER_ADMIN scope). */
  getAll(): Promise<ChainDTO[]>;
  /** Outlet restaurant ids attached to a chain. */
  getOutletIdsByChain(chainId: string): Promise<string[]>;
  getOutletChainId(restaurantId: string): Promise<string | null>;
  /** Creates a chain row (vendor onboarding CHAIN approval). */
  create(name: string, ownerId: string): Promise<ChainDTO>;
  /** Test/dev helper: seeds a chain plus its outlet attachments. */
  _seed(chain: ChainDTO, outletIds: string[]): void;
  _reset(): void;
}

export class MemoryChainRepository implements ChainRepository {
  private readonly chains = new Map<string, ChainDTO>();
  private readonly chainOutlets = new Map<string, string[]>();
  private readonly outletChain = new Map<string, string>();

  async getById(chainId: string): Promise<ChainDTO | null> {
    return this.chains.get(chainId) ?? null;
  }

  async getByOwner(ownerId: string): Promise<ChainDTO[]> {
    return Array.from(this.chains.values())
      .filter((c) => c.owner_id === ownerId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAll(): Promise<ChainDTO[]> {
    return Array.from(this.chains.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async getOutletIdsByChain(chainId: string): Promise<string[]> {
    return this.chainOutlets.get(chainId) ?? [];
  }

  async getOutletChainId(restaurantId: string): Promise<string | null> {
    return this.outletChain.get(restaurantId) ?? null;
  }

  async create(name: string, ownerId: string): Promise<ChainDTO> {
    const chain = makeChain(name, ownerId);
    this.chains.set(chain.id, chain);
    this.chainOutlets.set(chain.id, []);
    return chain;
  }

  _seed(chain: ChainDTO, outletIds: string[]): void {
    this.chains.set(chain.id, chain);
    this.chainOutlets.set(chain.id, [...outletIds]);
    for (const rid of outletIds) {
      this.outletChain.set(rid, chain.id);
    }
  }

  _reset(): void {
    this.chains.clear();
    this.chainOutlets.clear();
    this.outletChain.clear();
  }
}

/** Factory for deterministic chain ids in seeds/tests. */
export function chainId(seed = "c0000000-0000-4000-8000-000000000001"): string {
  return seed;
}

/** Test/dev helper: builds a ChainDTO. */
export function makeChain(
  name: string,
  ownerId: string,
  id = randomUUID(),
): ChainDTO {
  return { id, name, owner_id: ownerId, created_at: new Date().toISOString() };
}

export class DrizzleChainRepository implements ChainRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRow(row: Record<string, unknown>): ChainDTO {
    return {
      id: row.id as string,
      name: row.name as string,
      owner_id: row.owner_id as string,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  async getById(chainId: string): Promise<ChainDTO | null> {
    const rows = (await this.db
      .select()
      .from(chains)
      .where(eq(chains.id, chainId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async getByOwner(ownerId: string): Promise<ChainDTO[]> {
    const rows = (await this.db
      .select()
      .from(chains)
      .where(eq(chains.owner_id, ownerId))) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getAll(): Promise<ChainDTO[]> {
    const rows = (await this.db
      .select()
      .from(chains)
      .where(undefined)) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOutletIdsByChain(chainId: string): Promise<string[]> {
    const rows = (await this.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.chain_id, chainId))) as Record<string, unknown>[];
    return rows.map((r) => r.id as string);
  }

  async getOutletChainId(restaurantId: string): Promise<string | null> {
    const rows = (await this.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? ((row.chain_id as string | null) ?? null) : null;
  }

  async create(name: string, ownerId: string): Promise<ChainDTO> {
    const id = randomUUID();
    await this.db.insert(chains).values({
      id,
      name,
      owner_id: ownerId,
    });
    const chain = await this.getById(id);
    return chain!;
  }

  _seed(_chain: ChainDTO, _outletIds: string[]): void {}

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
