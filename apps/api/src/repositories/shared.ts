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
import type { RoleRepository } from "./roleRepository";
import type { VendorApplicationRepository } from "./vendorApplicationRepository";
import type { NotificationRepository } from "./notificationRepository";
import type { UserRoleRepository } from "./userRoleRepository";
import type { GiftRepository } from "./giftRepository";

import { MemoryOrderRepository } from "./orderRepository";
import { MemoryPaymentRepository } from "./paymentRepository";
import { MemoryAuditRepository } from "./auditRepository";
import { MemoryIdentityRepository } from "./identityRepository";
import { MemoryPosOrderRepository } from "./posRepository";
import { MemoryPromotionRepository } from "./promotionRepository";
import { MemoryLoyaltyRepository } from "./loyaltyRepository";
import { MemoryGroupCartRepository } from "./groupCartRepository";
import { MemoryChainRepository, DrizzleChainRepository } from "./chainRepository";
import { MemorySupportRepository } from "./supportRepository";
import { MemoryKillSwitchRepository } from "./killSwitchRepository";
import { MemoryRoleRepository } from "./roleRepository";
import { MemoryVendorApplicationRepository } from "./vendorApplicationRepository";
import { MemoryNotificationRepository } from "./notificationRepository";
import { MemoryUserRoleRepository } from "./userRoleRepository";
import { MemoryGiftRepository } from "./giftRepository";

import { DrizzleOrderRepository } from "./drizzle/drizzleOrderRepository";
import { DrizzlePaymentRepository } from "./drizzle/drizzlePaymentRepository";
import { DrizzleAuditRepository } from "./drizzle/drizzleAuditRepository";
import { DrizzleIdentityRepository } from "./drizzle/drizzleIdentityRepository";
import { DrizzleKillSwitchRepository } from "./killSwitchRepository";
import { DrizzleVendorApplicationRepository } from "./vendorApplicationRepository";
import { DrizzleNotificationRepository } from "./notificationRepository";
import { DrizzleUserRoleRepository } from "./userRoleRepository";
import { DrizzleGiftRepository } from "./drizzle/drizzleGiftRepository";

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
  // TEST_REAL_INFRA explicitly demands real Postgres + Redis. It is
  // authoritative: never fall back to memory in this mode.
  if (process.env.TEST_REAL_INFRA === "true") return false;
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
  sharedPaymentRepo: PaymentRepository & {
    _reset(): void;
    _seedFinalized(input: {
      order_id?: string | null;
      gift_id?: string | null;
      razorpay_order_id: string;
      razorpay_payment_id?: string | null;
      amount: number;
      currency?: string;
      status?: import("./paymentRepository").PaymentStatus;
      method?: string;
      receipt?: string;
    }): import("./paymentRepository").PaymentDTO;
  };  sharedAuditRepo: AuditRepository & { _reset(): void };
  sharedIdentityRepo: IdentityRepository & { _reset(): void; _seed(user: unknown): void };
  sharedPosOrderRepo: PosOrderRepository & { _reset(): void };
  sharedPromotionRepo: PromotionRepository & { _reset(): void };
  sharedLoyaltyRepo: LoyaltyRepository & { _reset(): void };
  sharedGroupCartRepo: GroupCartRepository & { _reset(): void };
  sharedChainRepo: ChainRepository & { _reset(): void; _seed(chain: unknown, outletIds: string[]): void };
  sharedSupportRepo: SupportRepository & { _reset(): void };
  sharedKillSwitchRepo: KillSwitchRepository & { _reset(): void };
  sharedRoleRepo: RoleRepository & { _reset(): void };
  sharedVendorApplicationRepo: VendorApplicationRepository & { _reset(): void; _seed(app: unknown): void };
  sharedNotificationRepo: NotificationRepository & { _reset(): void };
  sharedUserRoleRepo: UserRoleRepository & { _reset(): void; _seed(dto: unknown): void };
  sharedGiftRepo: GiftRepository & { _reset(): void };
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
      sharedRoleRepo: new MemoryRoleRepository(),
      sharedVendorApplicationRepo: new MemoryVendorApplicationRepository(),
      sharedNotificationRepo: new MemoryNotificationRepository(),
      sharedUserRoleRepo: new MemoryUserRoleRepository(),
      sharedGiftRepo: new MemoryGiftRepository(),
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
        sharedChainRepo: new DrizzleChainRepository(db) as unknown as RepoSet["sharedChainRepo"],
        sharedSupportRepo: new MemorySupportRepository(),
        sharedKillSwitchRepo: new DrizzleKillSwitchRepository(db) as unknown as RepoSet["sharedKillSwitchRepo"],
        sharedRoleRepo: new MemoryRoleRepository(),
        sharedVendorApplicationRepo: new DrizzleVendorApplicationRepository(db) as unknown as RepoSet["sharedVendorApplicationRepo"],
        sharedNotificationRepo: new DrizzleNotificationRepository(db) as unknown as RepoSet["sharedNotificationRepo"],
        sharedUserRoleRepo: new DrizzleUserRoleRepository(db) as unknown as RepoSet["sharedUserRoleRepo"],
        sharedGiftRepo: new DrizzleGiftRepository(db) as unknown as RepoSet["sharedGiftRepo"],
      };
    } catch (err) {
      if (process.env.TEST_REAL_INFRA === "true") {
        // Fail loud: real infra was demanded, never degrade to memory.
        throw err;
      }
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
        sharedRoleRepo: new MemoryRoleRepository(),
        sharedVendorApplicationRepo: new MemoryVendorApplicationRepository(),
        sharedNotificationRepo: new MemoryNotificationRepository(),
        sharedUserRoleRepo: new MemoryUserRoleRepository(),
        sharedGiftRepo: new MemoryGiftRepository(),
      };
    }
  }

  return _repos;
}

// ============================================
// Lazy repository accessors.
//
// These used to be eager top-level constants (e.g.
// `export const sharedOrderRepo = getRepos().sharedOrderRepo`). That forced
// getRepos() to run at module-load time, before index.ts could probe
// PostgreSQL and set USE_MEMORY_REPOS. As a result the in-memory fallback
// never engaged when Postgres was unreachable (e.g. a preview environment
// without a database), and the API kept routing every query through the
// Drizzle repositories and failing with a 500.
//
// The proxies below defer getRepos() to the first property access, so the
// storage-mode decision is locked in lazily after the runtime probe has
// completed. The public API (`sharedOrderRepo.find...`, `_reset()`, `_seed()`)
// is unchanged.
// ============================================

function createLazyRepo<K extends keyof RepoSet>(key: K): RepoSet[K] {
  const handler: ProxyHandler<RepoSet[K]> = {
    get(_target, prop) {
      const repo = getRepos()[key] as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(repo, prop, repo);
      return typeof value === "function" ? value.bind(repo) : value;
    },
    set(_target, prop, value) {
      const repo = getRepos()[key] as unknown as Record<PropertyKey, unknown>;
      return Reflect.set(repo, prop, value, repo);
    },
    has(_target, prop) {
      const repo = getRepos()[key] as unknown as Record<PropertyKey, unknown>;
      return Reflect.has(repo, prop);
    },
    ownKeys(_target) {
      const repo = getRepos()[key] as unknown as Record<PropertyKey, unknown>;
      return Reflect.ownKeys(repo);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const repo = getRepos()[key] as unknown as Record<PropertyKey, unknown>;
      return Reflect.getOwnPropertyDescriptor(repo, prop);
    },
  };
  return new Proxy({} as RepoSet[K], handler);
}

export const sharedOrderRepo = createLazyRepo("sharedOrderRepo");
export const sharedPaymentRepo = createLazyRepo("sharedPaymentRepo");
export const sharedAuditRepo = createLazyRepo("sharedAuditRepo");
export const sharedIdentityRepo = createLazyRepo("sharedIdentityRepo");
export const sharedPosOrderRepo = createLazyRepo("sharedPosOrderRepo");
export const sharedPromotionRepo = createLazyRepo("sharedPromotionRepo");
export const sharedLoyaltyRepo = createLazyRepo("sharedLoyaltyRepo");
export const sharedGroupCartRepo = createLazyRepo("sharedGroupCartRepo");
export const sharedChainRepo = createLazyRepo("sharedChainRepo");
export const sharedSupportRepo = createLazyRepo("sharedSupportRepo");
export const sharedKillSwitchRepo = createLazyRepo("sharedKillSwitchRepo");
export const sharedRoleRepo = createLazyRepo("sharedRoleRepo");
export const sharedVendorApplicationRepo = createLazyRepo("sharedVendorApplicationRepo");
export const sharedNotificationRepo = createLazyRepo("sharedNotificationRepo");
export const sharedUserRoleRepo = createLazyRepo("sharedUserRoleRepo");
export const sharedGiftRepo = createLazyRepo("sharedGiftRepo");
