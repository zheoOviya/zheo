import type { OrderRepository, OrderDTO } from "./orderRepository";
import type { PaymentRepository } from "./paymentRepository";
import type { AuditRepository } from "./auditRepository";
import type { IdentityRepository } from "./identityRepository";
import type { PosOrderRepository } from "./posRepository";
import type { PromotionRepository } from "./promotionRepository";
import type { LoyaltyRepository } from "./loyaltyRepository";
import type { GroupCartRepository } from "./groupCartRepository";
import type { ChainRepository } from "./chainRepository";
import type { SupportRepository } from "./supportRepository";
import type { KillSwitchRepository } from "./killSwitchRepository";

import { MemoryOrderRepository } from "./orderRepository";
import { MemoryPaymentRepository } from "./paymentRepository";
import { MemoryAuditRepository } from "./auditRepository";
import { MemoryIdentityRepository } from "./identityRepository";
import { MemoryPosOrderRepository } from "./posRepository";
import { MemoryPromotionRepository } from "./promotionRepository";
import { MemoryLoyaltyRepository } from "./loyaltyRepository";
import { MemoryGroupCartRepository } from "./groupCartRepository";
import { MemoryChainRepository } from "./chainRepository";
import { MemorySupportRepository } from "./supportRepository";
import { MemoryKillSwitchRepository } from "./killSwitchRepository";

import { DrizzleOrderRepository } from "./drizzle/drizzleOrderRepository";
import { DrizzlePaymentRepository } from "./drizzle/drizzlePaymentRepository";
import { DrizzleAuditRepository } from "./drizzle/drizzleAuditRepository";
import { DrizzleIdentityRepository } from "./drizzle/drizzleIdentityRepository";
import { DrizzleKillSwitchRepository } from "./killSwitchRepository";

import { getDb } from "../lib/db";

// ============================================
// Conditional repository instantiation.
// Drizzle (Postgres) when available, Memory otherwise.
// Tests always use Memory repos (backward compatible).
// ============================================

function isDbAvailable(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

function isMemoryMode(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.USE_MEMORY_REPOS === "true" ||
    !isDbAvailable()
  );
}

// ============================================
// Lazily-initialized singleton repo instances.
// Once the module loads the decision is locked in
// for the lifetime of the process.
// ============================================

interface RepoSet {
  sharedOrderRepo: OrderRepository & { _reset(): void; _seed(order: OrderDTO): OrderDTO };
  sharedPaymentRepo: PaymentRepository & { _reset(): void };
  sharedAuditRepo: AuditRepository & { _reset(): void };
  sharedIdentityRepo: IdentityRepository & { _reset(): void; _seed(user: unknown): void };
  sharedPosOrderRepo: PosOrderRepository & { _reset(): void };
  sharedPromotionRepo: PromotionRepository & { _reset(): void };
  sharedLoyaltyRepo: LoyaltyRepository & { _reset(): void };
  sharedGroupCartRepo: GroupCartRepository & { _reset(): void };
  sharedChainRepo: ChainRepository & { _reset(): void; _seed(chain: unknown, outletIds: string[]): void };
  sharedSupportRepo: SupportRepository & { _reset(): void };
  sharedKillSwitchRepo: KillSwitchRepository & { _reset(): void };
}

let _repos: RepoSet | null = null;
let _memoryMode = false;

/**
 * Reports the active storage backend once the repo set is locked in.
 * "postgres" when Drizzle repos are wired, "memory" otherwise (fallback mode).
 */
export function getStorageMode(): "postgres" | "memory" {
  getRepos();
  return _memoryMode ? "memory" : "postgres";
}

function getRepos(): RepoSet {
  if (_repos) return _repos;

  if (isMemoryMode()) {
    _memoryMode = true;
    _repos = {
      sharedOrderRepo: new MemoryOrderRepository(),
      sharedPaymentRepo: new MemoryPaymentRepository(),
      sharedAuditRepo: new MemoryAuditRepository(),
      sharedIdentityRepo: new MemoryIdentityRepository(),
      sharedPosOrderRepo: new MemoryPosOrderRepository(),
      sharedPromotionRepo: new MemoryPromotionRepository(),
      sharedLoyaltyRepo: new MemoryLoyaltyRepository(),
      sharedGroupCartRepo: new MemoryGroupCartRepository(),
      sharedChainRepo: new MemoryChainRepository(),
      sharedSupportRepo: new MemorySupportRepository(),
      sharedKillSwitchRepo: new MemoryKillSwitchRepository(),
    };
  } else {
    const db = getDb();
    try {
      _repos = {
        sharedOrderRepo: new DrizzleOrderRepository(db) as unknown as RepoSet["sharedOrderRepo"],
        sharedPaymentRepo: new DrizzlePaymentRepository(db) as unknown as RepoSet["sharedPaymentRepo"],
        sharedAuditRepo: new DrizzleAuditRepository(db) as unknown as RepoSet["sharedAuditRepo"],
        sharedIdentityRepo: new DrizzleIdentityRepository(db) as unknown as RepoSet["sharedIdentityRepo"],
        sharedPosOrderRepo: new MemoryPosOrderRepository(),
        sharedPromotionRepo: new MemoryPromotionRepository(),
        sharedLoyaltyRepo: new MemoryLoyaltyRepository(),
        sharedGroupCartRepo: new MemoryGroupCartRepository(),
        sharedChainRepo: new MemoryChainRepository(),
        sharedSupportRepo: new MemorySupportRepository(),
        sharedKillSwitchRepo: new DrizzleKillSwitchRepository(db) as unknown as RepoSet["sharedKillSwitchRepo"],
      };
    } catch {
      _repos = {
        sharedOrderRepo: new MemoryOrderRepository(),
        sharedPaymentRepo: new MemoryPaymentRepository(),
        sharedAuditRepo: new MemoryAuditRepository(),
        sharedIdentityRepo: new MemoryIdentityRepository(),
        sharedPosOrderRepo: new MemoryPosOrderRepository(),
        sharedPromotionRepo: new MemoryPromotionRepository(),
        sharedLoyaltyRepo: new MemoryLoyaltyRepository(),
        sharedGroupCartRepo: new MemoryGroupCartRepository(),
        sharedChainRepo: new MemoryChainRepository(),
        sharedSupportRepo: new MemorySupportRepository(),
        sharedKillSwitchRepo: new MemoryKillSwitchRepository(),
      };
    }
  }

  return _repos;
}

export const sharedOrderRepo = getRepos().sharedOrderRepo;
export const sharedPaymentRepo = getRepos().sharedPaymentRepo;
export const sharedAuditRepo = getRepos().sharedAuditRepo;
export const sharedIdentityRepo = getRepos().sharedIdentityRepo;
export const sharedPosOrderRepo = getRepos().sharedPosOrderRepo;
export const sharedPromotionRepo = getRepos().sharedPromotionRepo;
export const sharedLoyaltyRepo = getRepos().sharedLoyaltyRepo;
export const sharedGroupCartRepo = getRepos().sharedGroupCartRepo;
export const sharedChainRepo = getRepos().sharedChainRepo;
export const sharedSupportRepo = getRepos().sharedSupportRepo;
export const sharedKillSwitchRepo = getRepos().sharedKillSwitchRepo;
