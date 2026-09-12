import type { OrderStatus } from "@snakzap/types";
import type { OrderDTO } from "./orderRepository";
import type { GiftDTO } from "./giftRepository";

// ============================================
// Fulfillment atomicity transaction contracts (FULFILLMENT-CAS-OTP-ATOMICITY).
//
// Narrow structural interfaces describing only what the fulfillment
// orchestration needs, so the transaction cannot reach unrelated repository
// APIs. Concrete Drizzle repositories satisfy these structurally once bound
// to the same transaction handle.
// ============================================

export interface FulfillmentOrderRepo {
  getById(orderId: string): Promise<OrderDTO | null>;
  /** CAS status transition; null on missing row or state mismatch. */
  transitionStatus(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ): Promise<OrderDTO | null>;
  /** CAS CONFIRMED->PREPARING persisting the OTP in the same mutation. */
  claimPreparingWithOtp(
    orderId: string,
    fromStatus: OrderStatus,
    otp: string,
    qrToken?: string,
  ): Promise<OrderDTO | null>;
  /** CAS single-use pickup consuming the OTP and setting PICKED_UP. */
  consumePickupOtp(
    orderId: string,
    fromStatus: OrderStatus,
    otp: string,
  ): Promise<OrderDTO | null>;
}

export interface FulfillmentGiftRepo {
  /** CAS unbind: clears the order binding only when this order holds it. */
  releaseFromOrder(id: string, orderId: string): Promise<GiftDTO | null>;
  /** CAS fulfill: only from CLAIMED by the order that redeemed the gift. */
  markFulfilled(id: string, orderId: string): Promise<GiftDTO | null>;
}

export interface FulfillmentTxRepos {
  orders: FulfillmentOrderRepo;
  gifts: FulfillmentGiftRepo;
}

export interface FulfillmentTransactionPort {
  runInTransaction<T>(fn: (repos: FulfillmentTxRepos) => Promise<T>): Promise<T>;
}

/** Resolves the memory-backed repositories for the fulfillment transaction. */
export type FulfillmentTxRepoProvider = () => FulfillmentTxRepos;

/**
 * Memory/test transaction port.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE.
 *
 * This is an explicit PASSTHROUGH execution model: the callback receives the
 * existing memory-backed repositories, with no snapshotting, no locking, no
 * rollback and no concurrency guarantee. A throwing callback may leave partial
 * mutations in place. It exists only so service/unit tests can exercise the
 * fulfillment control flow and CAS semantics; real atomicity is Postgres-only
 * and proven by the real-PG harness.
 *
 * The provider is resolved at call time so the port always observes the
 * current route-visible stores (no stale instances across test resets).
 */
export class MemoryFulfillmentTransactionPort
  implements FulfillmentTransactionPort
{
  constructor(private readonly provider: FulfillmentTxRepoProvider) {}

  async runInTransaction<T>(
    fn: (repos: FulfillmentTxRepos) => Promise<T>,
  ): Promise<T> {
    return fn(this.provider());
  }
}
