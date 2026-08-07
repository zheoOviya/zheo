import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// Event Bus (EOS 1.2) - currently logs events;
// plugs into Kafka/NATS in production.
// ============================================

export type EventHandler = (
  event: TypedEventEnvelope<EventName>,
) => Promise<void>;

const handlers = new Map<EventName, EventHandler[]>();

export function onEvent(name: EventName, handler: EventHandler): void {
  const list = handlers.get(name) ?? [];
  list.push(handler);
  handlers.set(name, list);
}

export async function emit<K extends EventName>(
  event: TypedEventEnvelope<K>,
): Promise<void> {
  logger.info({
    message: "event_emitted",
    event_name: event.event_name,
    event_id: event.event_id,
    aggregate_id: event.aggregate_id,
  });

  const list = handlers.get(event.event_name as EventName) ?? [];
  for (const handler of list) {
    try {
      await handler(event as TypedEventEnvelope<EventName>);
    } catch (err) {
      logger.error({
        message: "event_handler_error",
        event_name: event.event_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Helper to build an event envelope with correlation tracking.
export function createEventEnvelope<K extends EventName>(
  event_name: K,
  aggregate_id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  metadata: Record<string, unknown> = {},
): TypedEventEnvelope<K> {
  return {
    event_id: randomUUID(),
    event_name,
    aggregate_id,
    timestamp: new Date(),
    payload,
    metadata,
  };
}
