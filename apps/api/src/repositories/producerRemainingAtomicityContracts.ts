import type { AuditRepository } from "./auditRepository";
import type { CatalogRepository } from "./catalogRepository";
import type { EventOutboxRepository } from "./eventOutboxRepository";
import type { GiftRepository } from "./giftRepository";
import type { IdentityRepository } from "./identityRepository";
import type { LoyaltyRepository } from "./loyaltyRepository";
import type { SupportRepository } from "./supportRepository";

// ============================================
// Producer remaining atomicity transaction contracts (EVT-B2B-NP2).
//
// The remaining scoped producers (gift expiry, referral claim, VIP ticket,
// user spice profile, POS menu sync) must persist their business mutation and
// their `event_outbox` INSERT inside the SAME PostgreSQL transaction. Each
// contract below is deliberately narrow: a scope exposes only the exact repo
// methods its producer needs plus the outbox `enqueue`, and every repository is
// constructed from one transaction handle. Nothing here reaches the relay,
// transport, consumers or unrelated repository APIs.
// ============================================

/** The only outbox capability any producer transaction scope may use. */
export type ProducerOutboxEnqueuer = Pick<EventOutboxRepository, "enqueue">;

/**
 * Generic memory/test transaction port.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE. This is an explicit PASSTHROUGH execution
 * model: the callback receives the existing memory-backed repositories with no
 * snapshotting, locking or rollback. A throwing callback may leave partial
 * mutations in place. It exists only so dev/test wiring runs; real atomicity is
 * Postgres-only and proven by the real-PG harness.
 *
 * The provider is resolved at call time so the port always observes the current
 * route-visible stores (no stale instances across test resets).
 */
export class MemoryProducerTransactionPort<TRepos> {
  constructor(private readonly provider: () => TRepos) {}

  runInTransaction<T>(fn: (repos: TRepos) => Promise<T>): Promise<T> {
    return fn(this.provider());
  }
}

// ---------------------------------------------------------------------------
// Gift expiry (GiftExpired)
// ---------------------------------------------------------------------------

export interface GiftExpiryTxRepos {
  gifts: Pick<GiftRepository, "expireIfDueAndUnbound">;
  outbox: ProducerOutboxEnqueuer;
}

export interface GiftExpiryTransactionPort {
  runInTransaction<T>(fn: (repos: GiftExpiryTxRepos) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Referral claim (ReferralClaimed): claim record + both wallet credits + audit
// ---------------------------------------------------------------------------

export interface ReferralTxRepos {
  loyalty: Pick<LoyaltyRepository, "recordClaim" | "creditWallet">;
  audit: Pick<AuditRepository, "log">;
  outbox: ProducerOutboxEnqueuer;
}

export interface ReferralTransactionPort {
  runInTransaction<T>(fn: (repos: ReferralTxRepos) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// VIP ticket (VipTicketCreated)
// ---------------------------------------------------------------------------

export interface VipTicketTxRepos {
  support: Pick<SupportRepository, "create">;
  outbox: ProducerOutboxEnqueuer;
}

export interface VipTicketTransactionPort {
  runInTransaction<T>(fn: (repos: VipTicketTxRepos) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Spice profile (SpiceProfileUpdated)
// ---------------------------------------------------------------------------

export interface SpiceProfileTxRepos {
  identity: Pick<IdentityRepository, "updateSpiceTolerance">;
  outbox: ProducerOutboxEnqueuer;
}

export interface SpiceProfileTransactionPort {
  runInTransaction<T>(fn: (repos: SpiceProfileTxRepos) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// POS menu sync (PosMenuSynced)
// ---------------------------------------------------------------------------

export interface MenuSyncTxRepos {
  catalog: Pick<CatalogRepository, "upsertPosMenuItems">;
  outbox: ProducerOutboxEnqueuer;
}

export interface MenuSyncTransactionPort {
  runInTransaction<T>(fn: (repos: MenuSyncTxRepos) => Promise<T>): Promise<T>;
}
