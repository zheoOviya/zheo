import type { OrderStatus } from "@snakzap/types";
import type { CreateOrderInput, OrderDTO } from "./orderRepository";
import type { EventOutboxRepository } from "./eventOutboxRepository";

// ============================================
// Catering order transaction contracts (EVT-B2B-NP1).
//
// A deliberately narrow seam: the catering create+confirm flow needs only to
// create the order, CAS DRAFT->CONFIRMED, and enqueue CateringOrderCreated.
// Binding all three to ONE transaction handle closes the historical two-commit
// create/confirm gap: the confirmation and its event now commit together, and a
// failed confirmation rolls the whole order back (no orphan DRAFT row).
// ============================================

export interface CateringOrderRepo {
  create(input: CreateOrderInput): Promise<OrderDTO>;
  /** CAS DRAFT->CONFIRMED; null on missing row or state mismatch. */
  transitionStatus(
    orderId: string,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
  ): Promise<OrderDTO | null>;
}

export interface CateringTxRepos {
  orders: CateringOrderRepo;
  /**
   * Tx-scoped outbox on the SAME transaction handle as `orders`, so the
   * CateringOrderCreated row commits with the confirmed order or rolls back
   * with it. Only the narrow `enqueue` capability is exposed.
   */
  outbox: Pick<EventOutboxRepository, "enqueue">;
}

export interface CateringTransactionPort {
  runInTransaction<T>(fn: (repos: CateringTxRepos) => Promise<T>): Promise<T>;
}

/** Resolves the memory-backed repositories for the catering transaction. */
export type CateringTxRepoProvider = () => CateringTxRepos;

/**
 * Memory/test passthrough transaction port.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE. No snapshotting, locking, or rollback; the
 * callback receives the existing memory-backed repositories directly. Real
 * atomicity is Postgres-only and proven by the real-PG harness.
 */
export class MemoryCateringTransactionPort implements CateringTransactionPort {
  constructor(private readonly provider: CateringTxRepoProvider) {}

  async runInTransaction<T>(
    fn: (repos: CateringTxRepos) => Promise<T>,
  ): Promise<T> {
    return fn(this.provider());
  }
}
