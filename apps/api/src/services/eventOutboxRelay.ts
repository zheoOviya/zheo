import type { EventName, TypedEventEnvelope } from "@snakzap/types";
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
