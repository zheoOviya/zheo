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

// Uniquely identifies THIS process as the origin of the events it publishes.
// The subscriber ignores broadcasts whose origin is this process, so a Redis
// loop-back can never double-dispatch on the originating instance — no
// count-bounded cache, FIFO, TTL or timing assumption is needed.
const INSTANCE_ID = randomUUID();

// Wire payload carried on EVENT_CHANNEL. Publishers always send the wrapped
// form; the unwrap() fallback accepts legacy raw envelopes from older
// instances during a rolling deploy.
type WireEvent =
  | { origin_instance_id: string; event: TypedEventEnvelope<EventName> }
  | TypedEventEnvelope<EventName>;

export type EventHandler = (
  event: TypedEventEnvelope<EventName>,
) => Promise<void>;

const handlers = new Map<EventName, EventHandler[]>();
let subscriberInitialized = false;

export function resetEventBusForTests(): void {
  handlers.clear();
  subscriberInitialized = false;
}

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

// Decode a payload received on EVENT_CHANNEL into an event to dispatch, or
// null when it is this instance's own broadcast (skip) or is unparseable.
function unwrapWire(raw: string): TypedEventEnvelope<EventName> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const maybe = parsed as Record<string, unknown>;
  if (
    typeof maybe.origin_instance_id === "string" &&
    maybe.event !== null &&
    typeof maybe.event === "object"
  ) {
    if (maybe.origin_instance_id === INSTANCE_ID) return null;
    return maybe.event as TypedEventEnvelope<EventName>;
  }
  // Legacy raw envelope published by an older instance (this process always
  // wraps, so a raw payload is necessarily remote) — dispatch it.
  return parsed as TypedEventEnvelope<EventName>;
}

export async function emit<K extends EventName>(
  event: TypedEventEnvelope<K>,
): Promise<void> {
  await dispatchToHandlers(event as TypedEventEnvelope<EventName>);

  try {
    const redis = getRedis();
    const wire: WireEvent = {
      origin_instance_id: INSTANCE_ID,
      event: event as TypedEventEnvelope<EventName>,
    };
    await redis.publish(EVENT_CHANNEL, JSON.stringify(wire));
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
    const sub = redis.duplicate();
    sub.on("message", (channel: unknown, message: unknown) => {
      if (channel !== EVENT_CHANNEL) return;
      const event = unwrapWire(message as string);
      if (!event) return;
      void dispatchToHandlers(event);
    });
    // Ensure the dedicated connection is up before issuing SUBSCRIBE; a
    // lazy client with enableOfflineQueue:false rejects the first command.
    await sub.connect();
    await sub.subscribe(EVENT_CHANNEL);
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
