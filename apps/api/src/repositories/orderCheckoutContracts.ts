import type { OrderStatus } from "@snakzap/types";
import type { CreateOrderInput, OrderDTO } from "./orderRepository";
import type { GiftDTO } from "./giftRepository";

// ============================================
// Consumer checkout transaction contracts (ORDER-AGGREGATE-IDEMPOTENCY-A3).
//
// Narrow structural interfaces describing only what the checkout orchestration
// needs, so the transaction cannot reach unrelated repository APIs. Concrete
// Drizzle repositories satisfy these structurally once bound to the same
// transaction handle, which makes order creation, every order item, and each
// gift bind share one commit boundary.
// ============================================

export interface OrderCheckoutOrderRepo {
  create(input: CreateOrderInput): Promise<OrderDTO>;
  /**
   * Best-effort retirement of a checkout order whose gift bind lost the CAS.
   * Under Postgres this runs inside the transaction and is undone by the
   * rollback; under the memory passthrough it is the only thing that prevents a
   * leaked DRAFT row, matching the historical compensation behaviour.
   */
  updateStatus(orderId: string, status: OrderStatus): Promise<OrderDTO | null>;
}

export interface OrderCheckoutGiftRepo {
  /** CAS bind: only while CLAIMED and unbound; null on loss. */
  bindToOrder(id: string, orderId: string): Promise<GiftDTO | null>;
  /** Undo of a prior bind in the same checkout (no-op after a PG rollback). */
  releaseFromOrder(id: string, orderId: string): Promise<GiftDTO | null>;
}

export interface OrderCheckoutTxRepos {
  orders: OrderCheckoutOrderRepo;
  gifts: OrderCheckoutGiftRepo;
}

export interface OrderCheckoutTransactionPort {
  runInTransaction<T>(fn: (repos: OrderCheckoutTxRepos) => Promise<T>): Promise<T>;
}

/** Resolves the memory-backed repositories for the checkout transaction. */
export type OrderCheckoutTxRepoProvider = () => OrderCheckoutTxRepos;

/**
 * Memory/test transaction port.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE.
 *
 * Explicit PASSTHROUGH execution model: the callback receives the existing
 * memory-backed repositories, with no snapshotting, no locking, no rollback and
 * no concurrency guarantee. A throwing callback may leave partial mutations in
 * place; the checkout callback therefore keeps an in-callback compensation so a
 * lost gift CAS never leaves a leaked DRAFT order behind. Real atomicity is
 * Postgres-only and proven by the real-PG harness.
 *
 * The provider is resolved at call time so the port always observes the current
 * route-visible stores (no stale instances across test resets).
 */
export class MemoryOrderCheckoutTransactionPort
  implements OrderCheckoutTransactionPort
{
  constructor(private readonly provider: OrderCheckoutTxRepoProvider) {}

  async runInTransaction<T>(
    fn: (repos: OrderCheckoutTxRepos) => Promise<T>,
  ): Promise<T> {
    return fn(this.provider());
  }
}
