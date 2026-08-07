import { randomUUID } from "node:crypto";

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
