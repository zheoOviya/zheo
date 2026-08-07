import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";
import { logger } from "./logger";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// Event Bus (EOS 1.2) - Redis Pub/Sub for
// cross-instance event distribution.
// In-process dispatch runs first for same-process
// performance; Redis Pub/Sub broadcasts to other
// instances. Falls back to in-process-only when
// Redis is unavailable.
// ============================================

const EVENT_CHANNEL = "snakzap:events";

export type EventHandler = (
  event: TypedEventEnvelope<EventName>,
) => Promise<void>;

const handlers = new Map<EventName, EventHandler[]>();
let subscriberInitialized = false;

export function onEvent(name: EventName, handler: EventHandler): void {
  const list = handlers.get(name) ?? [];
  list.push(handler);
  handlers.set(name, list);
}

async function dispatchToHandlers(event: TypedEventEnvelope<EventName>): Promise<void> {
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

export async function emit<K extends EventName>(
  event: TypedEventEnvelope<K>,
): Promise<void> {
  await dispatchToHandlers(event as TypedEventEnvelope<EventName>);

  try {
    const redis = getRedis();
    await redis.publish(EVENT_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({
      message: "event_redis_publish_failed",
      event_name: event.event_name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function initEventSubscriber(): Promise<void> {
  if (subscriberInitialized) return;
  subscriberInitialized = true;

  try {
    const redis = getRedis();
    await redis.subscribe(EVENT_CHANNEL, async (channel, message) => {
      if (channel !== EVENT_CHANNEL) return;
      try {
        const event: TypedEventEnvelope<EventName> = JSON.parse(message);
        await dispatchToHandlers(event);
      } catch (err) {
        logger.error({
          message: "event_subscriber_dispatch_error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    logger.info({ message: "event_subscriber_initialized", channel: EVENT_CHANNEL });
  } catch (err) {
    logger.warn({
      message: "event_subscriber_init_failed",
      error: err instanceof Error ? err.message : String(err),
    });
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
