import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryAuditRepository } from "../repositories/auditRepository";
import { MemoryIdentityRepository } from "../repositories/identityRepository";
import { MemoryPosOrderRepository } from "../repositories/posRepository";
import { MemoryPromotionRepository } from "../repositories/promotionRepository";
import { MemoryLoyaltyRepository } from "../repositories/loyaltyRepository";
import { MemoryGroupCartRepository } from "../repositories/groupCartRepository";
import { MemoryChainRepository } from "../repositories/chainRepository";
import { MemorySupportRepository } from "../repositories/supportRepository";

// Shared in-memory repository instances.
// All routes share the same stores so state is consistent
// across contexts (e.g., orders created via /orders are visible
// to /payments/create-order).

export const sharedOrderRepo = new MemoryOrderRepository();
export const sharedPaymentRepo = new MemoryPaymentRepository();
export const sharedAuditRepo = new MemoryAuditRepository();
export const sharedIdentityRepo = new MemoryIdentityRepository();
export const sharedPosOrderRepo = new MemoryPosOrderRepository();
export const sharedPromotionRepo = new MemoryPromotionRepository();
export const sharedLoyaltyRepo = new MemoryLoyaltyRepository();
export const sharedGroupCartRepo = new MemoryGroupCartRepository();
export const sharedChainRepo = new MemoryChainRepository();
export const sharedSupportRepo = new MemorySupportRepository();
