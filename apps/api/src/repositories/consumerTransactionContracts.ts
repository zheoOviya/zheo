import type { LoyaltyRepository } from "./loyaltyRepository";
import type { NotificationRepository } from "./notificationRepository";
import type { OrderRepository } from "./orderRepository";
import type { PromotionRepository } from "./promotionRepository";
import {
  MemoryEventConsumerDedupRepository,
  type EventConsumerDedupRepository,
} from "./eventConsumerDedupRepository";

// ============================================
// Consumer transaction scope (EVT-C2).
//
// The durable event consumers must apply their business effect and record the
// (consumer_name, event_id) dedup marker on the SAME database transaction, so
// that:
//   - a duplicate delivery loses the marker claim and performs zero effect, and
//   - an effect failure rolls the marker back, keeping the event retryable.
//
// `claim` is the atomic concurrency authority (INSERT ... ON CONFLICT DO
// NOTHING). It returns true only for the transaction that newly inserted the
// marker. A `hasProcessed()`-then-write pattern is deliberately NOT offered: it
// races and would allow a double effect.
//
// The scope exposes only the repositories a consumer needs, each bound to one
// transaction handle. It is deliberately narrow: no producer/outbox writes and
// no relay/transport concerns live here.
// ============================================

export interface ConsumerTxScope {
  /** Atomic marker claim. `true` iff THIS transaction inserted the marker. */
  claim(consumerName: string, eventId: string): Promise<boolean>;
  loyalty: LoyaltyRepository;
  orders: OrderRepository;
  promotions: PromotionRepository;
  notifications: NotificationRepository;
}

export interface ConsumerTransactionPort {
  runInTransaction<T>(fn: (scope: ConsumerTxScope) => Promise<T>): Promise<T>;
}

/** The repos a memory-mode scope exposes (everything except the claim). */
export type ConsumerMemoryRepos = Omit<ConsumerTxScope, "claim">;

/**
 * Memory-mode scope is a PASSTHROUGH over the route-visible memory repos.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE: the in-process map cannot roll back a
 * claimed marker when a later effect throws, and concurrent "transactions" are
 * not isolated. It exists only so dev/test wiring runs; transactional
 * atomicity is proven exclusively against real PostgreSQL.
 *
 * The dedup map IS shared for the lifetime of the process so duplicate
 * deliveries are still suppressed within a single test/dev run.
 */
export class MemoryConsumerTransactionPort implements ConsumerTransactionPort {
  constructor(
    private readonly repos: () => ConsumerMemoryRepos,
    private readonly dedup: EventConsumerDedupRepository,
  ) {}

  runInTransaction<T>(fn: (scope: ConsumerTxScope) => Promise<T>): Promise<T> {
    const base = this.repos();
    return fn({
      ...base,
      claim: (consumerName, eventId) =>
        this.dedup.tryMarkProcessed(consumerName, eventId),
    });
  }
}

/** Process-wide memory dedup singleton used by the memory-mode port. */
export const memoryEventConsumerDedup = new MemoryEventConsumerDedupRepository();
