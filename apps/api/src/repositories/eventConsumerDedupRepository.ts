// ============================================
// Durable event-consumer dedup inbox — repository contract + memory
// implementation (EVT-C1).
//
// Generic at-most-once marker keyed by (consumer_name, event_id). The Postgres
// implementation is the durability source of truth; the memory implementation
// exists for dev/test parity ONLY:
//
//   MEMORY_MODE = NON_DURABLE_TEST_PARITY
//
// It is single-process and makes no durability claim across restarts. It must
// never be presented as production durability evidence, and it cannot prove
// transactional atomicity (use the real-Postgres harness for EVT-C1-6).
//
// Standalone `markProcessed` is NOT a production consumer flow. EVT-C2 must run
// `markProcessed` on the SAME transaction handle as the business effect (see
// `markProcessedInTx` in the Drizzle implementation), so the marker cannot
// commit ahead of the effect it guards.
// ============================================

export interface EventConsumerDedupRecord {
  consumer_name: string;
  event_id: string;
  processed_at: string;
}

export interface EventConsumerDedupRepository {
  /** True when this (consumer, event) pair has already been processed. */
  hasProcessed(consumerName: string, eventId: string): Promise<boolean>;
  /**
   * Atomically claim the (consumer, event) marker. Returns `true` iff THIS call
   * inserted the marker (i.e. won the claim) and `false` when the pair already
   * existed. The composite PRIMARY KEY is the concurrency authority, so exactly
   * one concurrent caller can win.
   */
  tryMarkProcessed(consumerName: string, eventId: string): Promise<boolean>;
  /**
   * Record the (consumer, event) marker. Idempotent: a duplicate pair never
   * creates a second marker and never throws.
   */
  markProcessed(consumerName: string, eventId: string): Promise<void>;
  _reset(): void;
}

function keyOf(consumerName: string, eventId: string): string {
  return `${consumerName}\u0000${eventId}`;
}

export class MemoryEventConsumerDedupRepository
  implements EventConsumerDedupRepository
{
  private readonly entries = new Map<string, EventConsumerDedupRecord>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return this.entries.has(keyOf(consumerName, eventId));
  }

  async markProcessed(consumerName: string, eventId: string): Promise<void> {
    const key = keyOf(consumerName, eventId);
    if (this.entries.has(key)) return;
    this.entries.set(key, {
      consumer_name: consumerName,
      event_id: eventId,
      processed_at: this.clock().toISOString(),
    });
  }

  async tryMarkProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const key = keyOf(consumerName, eventId);
    if (this.entries.has(key)) return false;
    this.entries.set(key, {
      consumer_name: consumerName,
      event_id: eventId,
      processed_at: this.clock().toISOString(),
    });
    return true;
  }

  /** Test seam: read every marker (no production caller). */
  _all(): EventConsumerDedupRecord[] {
    return Array.from(this.entries.values()).map((entry) => ({ ...entry }));
  }

  /** Resets the store between tests. */
  _reset(): void {
    this.entries.clear();
  }
}
