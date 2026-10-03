import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import { config } from "../config";
import { logger } from "../lib/logger";
import { publishDurableEnvelope } from "../lib/eventBus";
import {
  EVENT_OUTBOX_BATCH_SIZE,
  EVENT_OUTBOX_CLAIM_LEASE_MS,
  EVENT_OUTBOX_MAX_ATTEMPTS,
  eventOutboxBackoffMs,
  outboxRowToEnvelope,
  type EventOutboxRepository,
} from "../repositories/eventOutboxRepository";

// ============================================
// Durable event outbox relay (EVT-B1).
//
// One bounded tick claims due rows, publishes each persisted envelope through a
// STRICT transport seam, and completes or reschedules the row:
//
//   publish success  -> DELETE row
//   publish failure  -> attempts += 1
//                        attempts <  MAX -> PENDING + future backoff
//                        attempts >= MAX -> DEAD
//
// Semantics: DELIVERY = AT_LEAST_ONCE. EXACTLY_ONCE is NOT claimed. A worker
// that publishes and then dies before DELETE will replay the SAME event_id on
// the next tick (duplicate possible by design); consumer-side dedup is EVT-C.
//
// Observability is bounded and PII-free: only event identity, counts and
// attempt numbers are logged — never payload or metadata.
// ============================================

export type DurableEnvelopePublisher = (
  envelope: TypedEventEnvelope<EventName>,
) => Promise<void>;

export interface EventOutboxRelayDeps {
  repo: EventOutboxRepository;
  publish?: DurableEnvelopePublisher;
  now?: () => Date;
  maxAttempts?: number;
  leaseMs?: number;
  batchSize?: number;
}

export interface EventOutboxRelayTickResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
}

export class EventOutboxRelay {
  private readonly repo: EventOutboxRepository;
  private readonly publish: DurableEnvelopePublisher;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;

  constructor(deps: EventOutboxRelayDeps) {
    this.repo = deps.repo;
    this.publish = deps.publish ?? publishDurableEnvelope;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? EVENT_OUTBOX_MAX_ATTEMPTS;
    this.leaseMs = deps.leaseMs ?? EVENT_OUTBOX_CLAIM_LEASE_MS;
    this.batchSize = deps.batchSize ?? EVENT_OUTBOX_BATCH_SIZE;
  }

  /** One bounded relay pass. Safe to call repeatedly; never loops internally. */
  async tick(): Promise<EventOutboxRelayTickResult> {
    const claimed = await this.repo.claimDue({
      limit: this.batchSize,
      now: this.now(),
      leaseMs: this.leaseMs,
    });

    if (claimed.length > 0) {
      logger.info({ message: "event_outbox_claim", claimed: claimed.length });
    }

    let published = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const row of claimed) {
      const envelope = outboxRowToEnvelope(row);
      try {
        await this.publish(envelope);
        await this.repo.markPublished(row.id);
        published += 1;
        logger.info({
          message: "event_outbox_published",
          event_name: row.event_name,
          event_id: row.event_id,
        });
      } catch (err) {
        const attempts = row.attempts + 1;
        if (attempts >= this.maxAttempts) {
          await this.repo.markFailed({
            id: row.id,
            attempts,
            status: "DEAD",
            nextAttemptAt: null,
          });
          deadLettered += 1;
          logger.warn({
            message: "event_outbox_dead_letter",
            event_name: row.event_name,
            event_id: row.event_id,
            attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          const nextAttemptAt = new Date(
            this.now().getTime() + eventOutboxBackoffMs(attempts),
          );
          await this.repo.markFailed({
            id: row.id,
            attempts,
            status: "PENDING",
            nextAttemptAt,
          });
          retried += 1;
          logger.info({
            message: "event_outbox_retry_scheduled",
            event_name: row.event_name,
            event_id: row.event_id,
            attempts,
          });
        }
      }
    }

    return { claimed: claimed.length, published, retried, deadLettered };
  }
}

/** Bounded backlog read for observability; safe to call out of band. */
export async function eventOutboxBacklog(
  repo: EventOutboxRepository,
): Promise<number> {
  return repo.outstandingCount();
}

// ============================================
// Production bootstrap (EVT-RELAY-BOOTSTRAP).
//
// Makes the durable relay actually run as part of the API lifecycle WITHOUT
// changing delivery semantics: DELIVERY stays AT_LEAST_ONCE, the persisted
// event_id is preserved, and EXACTLY_ONCE is still not claimed.
//
// Lifecycle contract:
//   1. idempotent start (a second start is ignored while running)
//   2. one immediate boot tick
//   3. bounded periodic ticks
//   4. the timer is unref'd so it never holds the process open
//   5. no uncontrolled overlapping ticks (an in-flight tick suppresses the next)
//   6. stop prevents new ticks
//   7. stop awaits any in-flight tick
//   8. callers stop the relay BEFORE Redis quit / closeDb
//
// Production activation is fail-safe: there is deliberately NO enable flag, so
// the relay cannot be silently disabled on a production deploy. Only the
// cadence is configurable via EVENT_OUTBOX_RELAY_INTERVAL_MS (validated as a
// positive integer at config load).
// ============================================

/** Default bounded relay cadence (ms) when the interval env knob is unset. */
export const EVENT_OUTBOX_RELAY_INTERVAL_MS = 1_000;

export interface EventOutboxRelayBootstrapOptions {
  /** Pre-built relay (tests / real-infra harness). When omitted, `repo` is required. */
  relay?: EventOutboxRelay;
  /** Repository backing a relay built from these options. */
  repo?: EventOutboxRepository;
  publish?: DurableEnvelopePublisher;
  now?: () => Date;
  intervalMs?: number;
}

let relayInstance: EventOutboxRelay | null = null;
let relayTimer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<void> | null = null;

/** Resolves the configured cadence, falling back to the bounded default. */
export function resolveEventOutboxRelayIntervalMs(): number {
  return config.eventOutboxRelay.intervalMs ?? EVENT_OUTBOX_RELAY_INTERVAL_MS;
}

/**
 * Runs one bounded tick, guarded against overlap. Never rejects: a tick failure
 * is logged and swallowed so a transient error cannot stop future ticks or
 * reject the stop-await.
 */
function runRelayTick(relay: EventOutboxRelay): Promise<void> {
  if (inFlightTick) {
    logger.warn({ message: "event_outbox_relay_tick_skipped_overlap" });
    return inFlightTick;
  }
  const tick = relay
    .tick()
    .then(() => undefined)
    .catch((err) => {
      logger.error({
        message: "event_outbox_relay_tick_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      inFlightTick = null;
    });
  inFlightTick = tick;
  return tick;
}

/** Starts the relay: one immediate boot tick, then bounded periodic ticks. */
export function startEventOutboxRelay(
  options: EventOutboxRelayBootstrapOptions = {},
): void {
  if (relayInstance) return; // idempotent start

  if (!options.relay && !options.repo) {
    throw new Error("startEventOutboxRelay requires a relay or a repo");
  }

  const relay =
    options.relay ??
    new EventOutboxRelay({
      repo: options.repo as EventOutboxRepository,
      ...(options.publish ? { publish: options.publish } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

  const intervalMs = options.intervalMs ?? resolveEventOutboxRelayIntervalMs();

  relayInstance = relay;
  void runRelayTick(relay); // boot tick
  relayTimer = setInterval(() => {
    void runRelayTick(relay);
  }, intervalMs);
  relayTimer.unref();

  logger.info({ message: "event_outbox_relay_started", interval_ms: intervalMs });
}

/**
 * Stops scheduling and awaits any in-flight tick. Idempotent: a second call is a
 * no-op (and still awaits any tick that is somehow in flight). Call this BEFORE
 * Redis quit / closeDb so a tick cannot use a torn-down connection.
 */
export async function stopEventOutboxRelay(): Promise<void> {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
  relayInstance = null;

  const pending = inFlightTick;
  if (pending) {
    logger.info({ message: "event_outbox_relay_stop_awaiting_inflight" });
    await pending;
  }
  logger.info({ message: "event_outbox_relay_stopped" });
}

/** Test seam: whether a relay is currently scheduled. */
export function isEventOutboxRelayRunning(): boolean {
  return relayInstance !== null;
}
