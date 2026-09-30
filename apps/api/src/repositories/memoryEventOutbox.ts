import {
  MemoryEventOutboxRepository,
  type ClaimDueInput,
  type EventOutboxRow,
  type MarkFailedInput,
} from "./eventOutboxRepository";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// Shared memory-mode event outbox (EVT-B2A).
//
// The fulfillment and vendor-approval memory transaction ports are explicit
// PASSTHROUGH execution models (MEMORY_ATOMICITY_GUARANTEE = NONE). This
// instance exists so those ports can expose the same tx-shaped `outbox.enqueue`
// capability as the Postgres ports and so memory-mode tests can observe the
// enqueued work.
//
//   MEMORY_MODE = NON_DURABLE_TEST_PARITY
//
// It is NOT durability evidence and makes no rollback/commit claim. Real
// transactional commit and rollback are proven against PostgreSQL by
// realPgProducerOutboxBoundary.ts.
// ============================================

let current = new MemoryEventOutboxRepository();

export const memoryEventOutbox = {
  enqueue(envelope: TypedEventEnvelope<EventName>): Promise<void> {
    return current.enqueue(envelope);
  },
  claimDue(input: ClaimDueInput): Promise<EventOutboxRow[]> {
    return current.claimDue(input);
  },
  markPublished(id: string): Promise<void> {
    return current.markPublished(id);
  },
  markFailed(input: MarkFailedInput): Promise<void> {
    return current.markFailed(input);
  },
  outstandingCount(): Promise<number> {
    return current.outstandingCount();
  },
  /** Test seam: direct read of all rows (including DEAD). */
  _all(): EventOutboxRow[] {
    return current._all();
  },
  /** Test seam: drop all rows (fresh instance). */
  _reset(): void {
    current = new MemoryEventOutboxRepository();
  },
};
