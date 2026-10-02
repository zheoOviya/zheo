import { createEventEnvelope } from "../lib/eventBus";
import type { DineInOutboxEnqueuer } from "../repositories/dineInContracts";
import { mapDineInEventFacts } from "./dineInEventMapper";
import type { DineInEventFact } from "./dineInSession";

// ============================================
// Dine-In transactional event persistence (EVT-B2B-NP3-B).
//
// Supersedes the D2.5C9.2 post-commit best-effort emit. The scoped dine-in
// facts are now enqueued into the transactional outbox on the SAME transaction
// handle (`outbox`) that carries the authoritative business mutation, so:
//
//   - success mutation -> exactly one durable child row per fact
//   - duplicate / retry -> zero (business path short-circuits first)
//   - rollback          -> zero (enqueue is on the rolled-back tx)
//
// The mapper remains authoritative for event_name/aggregate_id/payload/
// metadata; envelope construction (event_id + timestamp) happens here at
// enqueue time. No event_name, schema, or migration change.
//
// Failure is NOT isolated any more: an enqueue rejection propagates into the
// owning transaction so the caller observes a rollback instead of a silent
// lost event. No automatic retry — the relay owns delivery.
// ============================================

export type DineInEventFactEmitter = (
  facts: readonly DineInEventFact[],
  correlationId: string,
  outbox: DineInOutboxEnqueuer,
) => Promise<void>;

export function buildDineInEventEnvelopes(
  facts: readonly DineInEventFact[],
  correlationId: string,
): ReturnType<typeof createEventEnvelope>[] {
  const descriptors = mapDineInEventFacts(facts, correlationId);
  return descriptors.map((descriptor) =>
    createEventEnvelope(
      descriptor.event_name,
      descriptor.aggregate_id,
      descriptor.payload,
      { ...descriptor.metadata },
    ),
  );
}

export async function enqueueDineInEventFacts(
  facts: readonly DineInEventFact[],
  correlationId: string,
  outbox: DineInOutboxEnqueuer,
): Promise<void> {
  if (facts.length === 0) return;
  for (const envelope of buildDineInEventEnvelopes(facts, correlationId)) {
    await outbox.enqueue(envelope);
  }
}
