import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";
import { mapDineInEventFacts } from "./dineInEventMapper";
import type { DineInEventFact } from "./dineInSession";

// ============================================
// Dine-In post-commit best-effort event emission (D2.5C9.2).
//
// This helper is invoked ONLY after runInTransaction has resolved
// successfully (post-commit boundary). It maps committed semantic facts
// to envelopes and emits them one-by-one.
//
// NO_DURABLE_TRANSACTIONAL_EVENT_DELIVERY:
//   A DB commit may succeed while an event is lost. There is NO outbox,
//   NO replay, NO exactly-once. Client retry is NOT event redelivery.
//
// Failure isolation (frozen rule): domain commit succeeds + emission fails
// => the domain operation STILL returns success. Each event is attempted
// independently; one rejected emit does NOT prevent the others.
//
// Safety:
//   - no DB access
//   - no mutation of domain state
//   - no automatic retry (a single best-effort pass)
//   - only existing EventBus API is consumed (no behavior change)
// ============================================

export type DineInEventFactEmitter = (
  facts: readonly DineInEventFact[],
  correlationId: string,
) => Promise<void>;

export async function emitDineInEventFactsBestEffort(
  facts: readonly DineInEventFact[],
  correlationId: string,
): Promise<void> {
  if (facts.length === 0) return;

  // Mapper is authoritative for event_name/aggregate_id/payload/metadata.
  // Envelope construction (event_id + timestamp) happens here, post-commit,
  // via the existing constructor. Timestamp = post-commit observation time.
  const descriptors = mapDineInEventFacts(facts, correlationId);

  for (const descriptor of descriptors) {
    try {
      const envelope = createEventEnvelope(
        descriptor.event_name,
        descriptor.aggregate_id,
        descriptor.payload,
        { ...descriptor.metadata },
      );
      await emit(envelope);
    } catch (err) {
      // Best-effort: never rethrow. Log identity fields ONLY — no payload,
      // no table_token, no PII, no payment data.
      logger.error({
        message: "dinein_event_emit_failed",
        event_name: descriptor.event_name,
        aggregate_id: descriptor.aggregate_id,
        correlation_id: descriptor.metadata.correlation_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
