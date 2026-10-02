import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryProducerTransactionPort,
  type GiftExpiryTransactionPort,
  type GiftExpiryTxRepos,
  type MenuSyncTransactionPort,
  type MenuSyncTxRepos,
  type ReferralTransactionPort,
  type ReferralTxRepos,
  type SpiceProfileTransactionPort,
  type SpiceProfileTxRepos,
  type VipTicketTransactionPort,
  type VipTicketTxRepos,
} from "../producerRemainingAtomicityContracts";
import { getStorageMode, sharedAuditRepo } from "../shared";
import { memoryEventOutbox } from "../memoryEventOutbox";
import type { CatalogRepository } from "../catalogRepository";
import type { GiftRepository } from "../giftRepository";
import type { IdentityRepository } from "../identityRepository";
import type { LoyaltyRepository } from "../loyaltyRepository";
import type { SupportRepository } from "../supportRepository";
import { DrizzleCatalogRepository } from "../catalogRepository";
import { DrizzleGiftRepository } from "./drizzleGiftRepository";
import { DrizzleIdentityRepository } from "./drizzleIdentityRepository";
import { DrizzleLoyaltyRepository } from "./drizzleLoyaltyRepository";
import { DrizzleSupportRepository } from "./drizzleSupportRepository";
import { DrizzleEventOutboxRepository } from "./drizzleEventOutboxRepository";
import { DrizzleAuditRepository } from "./drizzleAuditRepository";

// ============================================
// Drizzle transaction ports for the remaining scoped producers (EVT-B2B-NP2).
//
// Every `build*TxRepos` constructs its repositories from the SAME transaction
// handle as the outbox, so a producer's business write and its event row share
// one commit boundary: a committed producer persists exactly one logical row,
// and a rollback or CAS miss persists none.
//
// Runtime selectors take the producer's own repository so memory/test mode
// passthrough observes the exact route-visible store; Postgres mode ignores the
// argument and builds per-transaction repositories from the tx handle. getDb()
// is only reachable on the explicit postgres branch, so memory/test mode never
// constructs a Postgres client or falls back from a Postgres failure.
// ============================================

// ---------------------------------------------------------------------------
// Gift expiry
// ---------------------------------------------------------------------------

export function buildGiftExpiryTxRepos(tx: DrizzleDb): GiftExpiryTxRepos {
  return {
    gifts: new DrizzleGiftRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleGiftExpiryTransactionPort
  implements GiftExpiryTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: GiftExpiryTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildGiftExpiryTxRepos(tx)));
  }
}

let _giftExpiryPort: GiftExpiryTransactionPort | null = null;

export function getGiftExpiryTransactionPort(
  gifts: GiftRepository,
): GiftExpiryTransactionPort {
  if (getStorageMode() === "postgres") {
    _giftExpiryPort ??= new DrizzleGiftExpiryTransactionPort(getDb());
    return _giftExpiryPort;
  }
  return new MemoryProducerTransactionPort<GiftExpiryTxRepos>(() => ({
    gifts,
    outbox: memoryEventOutbox,
  }));
}

// ---------------------------------------------------------------------------
// Referral claim
// ---------------------------------------------------------------------------

export function buildReferralTxRepos(tx: DrizzleDb): ReferralTxRepos {
  return {
    loyalty: new DrizzleLoyaltyRepository(tx),
    audit: new DrizzleAuditRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleReferralTransactionPort implements ReferralTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: ReferralTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildReferralTxRepos(tx)));
  }
}

let _referralPort: ReferralTransactionPort | null = null;

export function getReferralTransactionPort(
  loyalty: LoyaltyRepository,
): ReferralTransactionPort {
  if (getStorageMode() === "postgres") {
    _referralPort ??= new DrizzleReferralTransactionPort(getDb());
    return _referralPort;
  }
  return new MemoryProducerTransactionPort<ReferralTxRepos>(() => ({
    loyalty,
    audit: sharedAuditRepo,
    outbox: memoryEventOutbox,
  }));
}

// ---------------------------------------------------------------------------
// VIP ticket
// ---------------------------------------------------------------------------

export function buildVipTicketTxRepos(tx: DrizzleDb): VipTicketTxRepos {
  return {
    support: new DrizzleSupportRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleVipTicketTransactionPort implements VipTicketTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: VipTicketTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildVipTicketTxRepos(tx)));
  }
}

let _vipTicketPort: VipTicketTransactionPort | null = null;

export function getVipTicketTransactionPort(
  support: SupportRepository,
): VipTicketTransactionPort {
  if (getStorageMode() === "postgres") {
    _vipTicketPort ??= new DrizzleVipTicketTransactionPort(getDb());
    return _vipTicketPort;
  }
  return new MemoryProducerTransactionPort<VipTicketTxRepos>(() => ({
    support,
    outbox: memoryEventOutbox,
  }));
}

// ---------------------------------------------------------------------------
// Spice profile
// ---------------------------------------------------------------------------

export function buildSpiceProfileTxRepos(tx: DrizzleDb): SpiceProfileTxRepos {
  return {
    identity: new DrizzleIdentityRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleSpiceProfileTransactionPort
  implements SpiceProfileTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: SpiceProfileTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildSpiceProfileTxRepos(tx)));
  }
}

let _spiceProfilePort: SpiceProfileTransactionPort | null = null;

export function getSpiceProfileTransactionPort(
  identity: IdentityRepository,
): SpiceProfileTransactionPort {
  if (getStorageMode() === "postgres") {
    _spiceProfilePort ??= new DrizzleSpiceProfileTransactionPort(getDb());
    return _spiceProfilePort;
  }
  return new MemoryProducerTransactionPort<SpiceProfileTxRepos>(() => ({
    identity,
    outbox: memoryEventOutbox,
  }));
}

// ---------------------------------------------------------------------------
// POS menu sync
// ---------------------------------------------------------------------------

export function buildMenuSyncTxRepos(tx: DrizzleDb): MenuSyncTxRepos {
  return {
    catalog: new DrizzleCatalogRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleMenuSyncTransactionPort implements MenuSyncTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: MenuSyncTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildMenuSyncTxRepos(tx)));
  }
}

let _menuSyncPort: MenuSyncTransactionPort | null = null;

export function getMenuSyncTransactionPort(
  catalog: CatalogRepository,
): MenuSyncTransactionPort {
  if (getStorageMode() === "postgres") {
    _menuSyncPort ??= new DrizzleMenuSyncTransactionPort(getDb());
    return _menuSyncPort;
  }
  return new MemoryProducerTransactionPort<MenuSyncTxRepos>(() => ({
    catalog,
    outbox: memoryEventOutbox,
  }));
}
