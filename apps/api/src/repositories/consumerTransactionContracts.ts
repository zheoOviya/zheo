import type { LoyaltyRepository } from "./loyaltyRepository";
import type { NotificationRepository } from "./notificationRepository";
import type { OrderRepository } from "./orderRepository";
import type { PromotionRepository } from "./promotionRepository";
import type { EventOutboxRepository } from "./eventOutboxRepository";
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
// transaction handle. It is deliberately narrow: no relay/transport concerns
// live here.
//
// EVT-B2B-NP3-A: the scope carries the outbox enqueue seam so a DURABLE
// CONSUMER can persist any nested/derived event row on the SAME transaction as
// its dedup marker and its business effect. This is an extension of the winning
// transaction, not a second transaction: the marker claim semantics, the
// consumer names and the retry model are unchanged. `enqueue` is the same
// producer primitive used by EVT-B1/B2 producers.
// ============================================

/** Narrow outbox write seam: enqueue only, on the caller's transaction. */
export type ConsumerOutboxEnqueuer = Pick<EventOutboxRepository, "enqueue">;

export interface ConsumerTxScope {
  /** Atomic marker claim. `true` iff THIS transaction inserted the marker. */
  claim(consumerName: string, eventId: string): Promise<boolean>;
  loyalty: LoyaltyRepository;
  orders: OrderRepository;
  promotions: PromotionRepository;
  notifications: NotificationRepository;
  /**
   * Enqueue a nested/derived event on the SAME transaction as the dedup claim
   * and the business effect. A rollback drops the enqueued row with them.
   */
  outbox: ConsumerOutboxEnqueuer;
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
