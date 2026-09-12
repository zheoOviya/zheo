import { randomUUID } from "node:crypto";
import {
  closeRedisSubscriber,
  ensureRedisReady,
  getRedis,
  getRedisSubscriber,
} from "./redis";
import type { RedisLike } from "./redis";
import { logger } from "./logger";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// Event Bus (EOS 1.2) - Redis Pub/Sub for
// cross-instance event distribution.
// In-process dispatch runs first for same-process
// performance; Redis Pub/Sub broadcasts to other
// instances. Falls back to in-process-only when
// Redis is unavailable.
//
// Isolation model (EVENTBUS-REDIS-ISOLATION):
// - The shared command client NEVER enters subscriber mode; EventBus uses a
//   dedicated duplicate connection (getRedisSubscriber).
// - Each process stamps outgoing events with a private source_instance_id and
//   skips its own echo, so a single published event is handled once locally
//   (in-process) and once per remote instance, never twice locally.
// ============================================

const EVENT_CHANNEL = "snakzap:events";

// Private, process-local, non-persisted, non-security identity. Used only to
// suppress the origin process's own Redis echo.
const SOURCE_INSTANCE_ID = randomUUID();

export type EventHandler = (
  event: TypedEventEnvelope<EventName>,
) => Promise<void>;

const handlers = new Map<EventName, EventHandler[]>();

type SubscriberState = "IDLE" | "CONNECTING" | "SUBSCRIBED";

let subscriberState: SubscriberState = "IDLE";
let initPromise: Promise<void> | null = null;
let stopped = false;
let subscriberRef: RedisLike | null = null;
let subscribedToChannel = false;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimal backward-compatible guard. Deliberately does NOT enforce a UUID
// aggregate_id or an object timestamp (wire JSON degrades both), and does not
// run the full EventEnvelopeSchema.
function isValidIncomingEvent(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.event_name !== "string" || value.event_name.length === 0) {
    return false;
  }
  if (typeof value.event_id !== "string") return false;
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) {
    return false;
  }
  return true;
}

function handleSubscriberError(err: unknown): void {
  logger.warn({
    message: "event_subscriber_error",
    error: err instanceof Error ? err.message : String(err),
  });
}

const messageListener = handleSubscriberMessage as (...args: unknown[]) => void;

// ioredis invokes the second argument of subscribe() as the command callback
// (err, count); actual pub/sub messages arrive on the "message" event.
const ignoreSubscribeCommandCallback = (): void => {
  // Intentionally empty: messages are handled by the "message" listener.
};

function handleSubscriberMessage(channel: string, message: string): void {
  if (channel !== EVENT_CHANNEL) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch (err) {
    logger.warn({
      message: "event_subscriber_malformed_json",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!isValidIncomingEvent(parsed)) {
    logger.warn({ message: "event_subscriber_invalid_shape" });
    return;
  }

  const event = parsed as TypedEventEnvelope<EventName>;
  if (event.metadata?.source_instance_id === SOURCE_INSTANCE_ID) {
    return;
  }

  void dispatchToHandlers(event).catch((err) => {
    logger.error({
      message: "event_subscriber_dispatch_error",
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function detachSubscriber(sub: RedisLike): Promise<void> {
  sub.off?.("error", handleSubscriberError);
  sub.off?.("message", messageListener);
  if (subscribedToChannel) {
    const unsub = (sub as { unsubscribe?: (channel: string) => unknown })
      .unsubscribe;
    if (typeof unsub === "function") {
      try {
        await unsub.call(sub, EVENT_CHANNEL);
      } catch (err) {
        logger.warn({
          message: "event_subscriber_unsubscribe_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    subscribedToChannel = false;
  }
}

async function doInit(): Promise<void> {
  let sub: RedisLike | null = null;
  try {
    sub = getRedisSubscriber();
    subscriberRef = sub;
    sub.off?.("error", handleSubscriberError);
    sub.on("error", handleSubscriberError);
    await ensureRedisReady(sub);
    sub.off?.("message", messageListener);
    sub.on("message", messageListener);
    await sub.subscribe(EVENT_CHANNEL, ignoreSubscribeCommandCallback);
    subscribedToChannel = true;

    if (stopped) {
      await detachSubscriber(sub);
      subscriberRef = null;
      return;
    }

    subscriberState = "SUBSCRIBED";
    logger.info({
      message: "event_subscriber_initialized",
      channel: EVENT_CHANNEL,
    });
  } catch (err) {
    logger.warn({
      message: "event_subscriber_init_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    if (sub) {
      await detachSubscriber(sub);
    }
    subscriberRef = null;
    subscriberState = "IDLE";
  } finally {
    initPromise = null;
  }
}

export function initEventSubscriber(): Promise<void> {
  if (stopped) return Promise.resolve();
  if (subscriberState === "SUBSCRIBED") return Promise.resolve();
  if (initPromise) return initPromise;
  subscriberState = "CONNECTING";
  initPromise = doInit();
  return initPromise;
}

export async function shutdownEventSubscriber(): Promise<void> {
  stopped = true;
  const sub = subscriberRef;
  subscriberRef = null;
  subscriberState = "IDLE";
  initPromise = null;

  if (sub) {
    try {
      await detachSubscriber(sub);
    } catch (err) {
      logger.warn({
        message: "event_subscriber_listener_remove_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await closeRedisSubscriber();
  } catch (err) {
    logger.warn({
      message: "event_subscriber_shutdown_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function emit<K extends EventName>(
  event: TypedEventEnvelope<K>,
): Promise<void> {
  await dispatchToHandlers(event as TypedEventEnvelope<EventName>);

  const published = {
    ...event,
    metadata: {
      ...event.metadata,
      source_instance_id: SOURCE_INSTANCE_ID,
    },
  };

  try {
    const redis = getRedis();
    await ensureRedisReady(redis);
    await redis.publish(EVENT_CHANNEL, JSON.stringify(published));
  } catch (err) {
    logger.warn({
      message: "event_redis_publish_failed",
      event_name: event.event_name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Test-only seams. Not used by production paths.
export function resetEventBusForTests(): void {
  stopped = false;
  subscriberState = "IDLE";
  initPromise = null;
  subscriberRef = null;
  subscribedToChannel = false;
}

export function getSourceInstanceIdForTests(): string {
  return SOURCE_INSTANCE_ID;
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
