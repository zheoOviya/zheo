import type {
  BillRequestedEvent,
  EventName,
  ServiceRequestAcknowledgedEvent,
  ServiceRequestCancelledEvent,
  ServiceRequestCompletedEvent,
  ServiceRequestCreatedEvent,
  SessionOpenedEvent,
} from "@snakzap/types";
import type { DineInEventFact } from "./dineInSession";

// ============================================
// Dine-In pure event mapping boundary (D2.5C9.1).
//
// Maps a committed semantic DineInEventFact to a deterministic envelope
// descriptor: { event_name, aggregate_id, payload, metadata }.
//
// Purity contract (this module has NO side effects):
//  - never emits / publishes (no eventBus, no Redis)
//  - never touches the DB (no repository, no re-reads)
//  - never reads request-global mutable state
//  - never generates a correlation id (uses the supplied one)
//  - no crypto.randomUUID / Date: no event_id, no timestamp here
//
// Actual EventEnvelope construction (event_id + timestamp via the existing
// constructor) and emission belong to C9.2. This module only produces the
// deterministic creation input.
// ============================================

export interface DineInEnvelopeMetadata {
  readonly correlation_id: string;
}

// Descriptor = existing event-envelope creation input minus event_id/timestamp.
// aggregate ownership: SessionOpened/BillRequested -> DiningSession.id,
// ServiceRequestCreated -> ServiceRequest.id. Never restaurant_id/table_id.
export type DineInEnvelopeDescriptor =
  | {
      readonly event_name: "SessionOpened";
      readonly aggregate_id: string;
      readonly payload: SessionOpenedEvent;
      readonly metadata: DineInEnvelopeMetadata;
    }
  | {
      readonly event_name: "BillRequested";
      readonly aggregate_id: string;
      readonly payload: BillRequestedEvent;
      readonly metadata: DineInEnvelopeMetadata;
    }
  | {
      readonly event_name: "ServiceRequestCreated";
      readonly aggregate_id: string;
      readonly payload: ServiceRequestCreatedEvent;
      readonly metadata: DineInEnvelopeMetadata;
    }
  | {
      readonly event_name: "ServiceRequestAcknowledged";
      readonly aggregate_id: string;
      readonly payload: ServiceRequestAcknowledgedEvent;
      readonly metadata: DineInEnvelopeMetadata;
    }
  | {
      readonly event_name: "ServiceRequestCompleted";
      readonly aggregate_id: string;
      readonly payload: ServiceRequestCompletedEvent;
      readonly metadata: DineInEnvelopeMetadata;
    }
  | {
      readonly event_name: "ServiceRequestCancelled";
      readonly aggregate_id: string;
      readonly payload: ServiceRequestCancelledEvent;
      readonly metadata: DineInEnvelopeMetadata;
    };

export function mapDineInEventFact(
  fact: DineInEventFact,
  correlationId: string,
): DineInEnvelopeDescriptor {
  const metadata: DineInEnvelopeMetadata = { correlation_id: correlationId };
  switch (fact.kind) {
    case "SESSION_OPENED":
      return {
        event_name: "SessionOpened",
        aggregate_id: fact.session_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          table_id: fact.table_id,
          customer_user_id: fact.customer_user_id,
        },
        metadata,
      };
    case "BILL_REQUESTED":
      return {
        event_name: "BillRequested",
        // aggregate is the DiningSession, NOT the bill.
        aggregate_id: fact.session_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          table_id: fact.table_id,
          session_bill_id: fact.bill_id,
          // Persisted SessionBill total_amount from the semantic fact;
          // NO recomputation, NO domain timestamp.
          total_amount: fact.total_amount,
        },
        metadata,
      };
    case "SERVICE_REQUEST_CREATED":
      return {
        event_name: "ServiceRequestCreated",
        // aggregate is the ServiceRequest, NOT the session.
        aggregate_id: fact.request_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          session_id: fact.session_id,
          request_type: fact.request_type,
          request_status: fact.request_status,
        },
        metadata,
      };
    case "SERVICE_REQUEST_ACKNOWLEDGED":
      return {
        event_name: "ServiceRequestAcknowledged",
        // aggregate is the ServiceRequest, NOT the session.
        aggregate_id: fact.request_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          session_id: fact.session_id,
          request_type: fact.request_type,
          request_status: fact.request_status,
        },
        metadata,
      };
    case "SERVICE_REQUEST_COMPLETED":
      return {
        event_name: "ServiceRequestCompleted",
        // aggregate is the ServiceRequest, NOT the session.
        aggregate_id: fact.request_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          session_id: fact.session_id,
          request_type: fact.request_type,
          request_status: fact.request_status,
        },
        metadata,
      };
    case "SERVICE_REQUEST_CANCELLED":
      return {
        event_name: "ServiceRequestCancelled",
        // aggregate is the ServiceRequest, NOT the session.
        aggregate_id: fact.request_id,
        payload: {
          restaurant_id: fact.restaurant_id,
          session_id: fact.session_id,
          request_type: fact.request_type,
          request_status: fact.request_status,
        },
        metadata,
      };
    default: {
      // Exhaustiveness guard: a new fact kind forces a compile error here
      // instead of silently dropping an event at runtime.
      const exhaustive: never = fact;
      return exhaustive;
    }
  }
}

// Maps ONLY explicit semantic facts. An empty fact list (e.g. a repeat
// outcome) maps to zero descriptors — the mapper never infers events from
// current session state.
export function mapDineInEventFacts(
  facts: readonly DineInEventFact[],
  correlationId: string,
): DineInEnvelopeDescriptor[] {
  return facts.map((fact) => mapDineInEventFact(fact, correlationId));
}

// Re-exported for consumer convenience (event_name typed as the accepted union).
export type DineInEventName = Extract<
  EventName,
  | "SessionOpened"
  | "BillRequested"
  | "ServiceRequestCreated"
  | "ServiceRequestAcknowledged"
  | "ServiceRequestCompleted"
  | "ServiceRequestCancelled"
>;
