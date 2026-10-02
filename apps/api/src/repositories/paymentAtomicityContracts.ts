import type { EventOutboxRepository } from "./eventOutboxRepository";
import type { GiftRepository } from "./giftRepository";
import type { OrderRepository } from "./orderRepository";
import type { PaymentRepository } from "./paymentRepository";

// ============================================
// Payment producer atomicity transaction contracts (EVT-B2B-PAY-A).
//
// The ordinary/local payment producers (CashOnPickupSelected, GiftPaid,
// PaymentSucceeded, PaymentFailed, GiftRefunded) must persist their local
// business mutation and their `event_outbox` INSERT inside the SAME PostgreSQL
// transaction. Each repo exposed here is deliberately narrow, and every
// repository is constructed from one transaction handle so the mutation and its
// event row share a single commit boundary.
//
// Gateway calls (Razorpay create-order / refund) are OUTSIDE this scope: a
// provider operation is never made atomic by a database outbox. This covers the
// local tail only (reconciliation, manual review and the gift.ts mock refund
// are PAY-B and untouched here).
// ============================================

/** The only outbox capability any payment transaction scope may use. */
export type PaymentOutboxEnqueuer = Pick<EventOutboxRepository, "enqueue">;

export interface PaymentTxRepos {
  payments: Pick<PaymentRepository, "create" | "updateWebhookResult">;
  orders: Pick<OrderRepository, "updateStatus" | "transitionStatus">;
  gifts: Pick<GiftRepository, "markPaid" | "markRefunded">;
  outbox: PaymentOutboxEnqueuer;
}

export interface PaymentTransactionPort {
  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T>;
}

/**
 * Memory/test transaction port.
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
export class MemoryPaymentTransactionPort implements PaymentTransactionPort {
  constructor(private readonly provider: () => PaymentTxRepos) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    return fn(this.provider());
  }
}
