import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// Durable event outbox — repository contract + memory implementation
// (EVT-B1).
//
// The outbox holds OUTSTANDING WORK only. A successfully published row is
// DELETED. Lifecycle:
//
//   PENDING = eligible / retryable
//   CLAIMED = lease-held by a relay worker
//   DEAD    = exhausted / non-retryable terminal failure
//   published successfully = row absent
//
// The Postgres implementation is the durability source of truth. The memory
// implementation exists for dev/test parity ONLY:
//
//   MEMORY_MODE = NON_DURABLE_TEST_PARITY
//
// It is single-process, has no real transaction rollback and makes no
// concurrency claim. It must never be presented as production durability
// evidence.
// ============================================

export type OutboxStatus = "PENDING" | "CLAIMED" | "DEAD";

/** Bounded retry policy. Centralized so callers/tests share one definition. */
export const EVENT_OUTBOX_MAX_ATTEMPTS = 5;
/** Lease duration a CLAIMED row is held before another worker may reclaim it. */
export const EVENT_OUTBOX_CLAIM_LEASE_MS = 30_000;
/** Maximum rows claimed per relay tick (no unbounded hot loop). */
export const EVENT_OUTBOX_BATCH_SIZE = 50;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;

/** Exponential backoff (capped) for the Nth failed attempt (N >= 1). */
export function eventOutboxBackoffMs(attempts: number): number {
  const safe = Math.max(1, Math.floor(attempts));
  const raw = BACKOFF_BASE_MS * 2 ** (safe - 1);
  return Math.min(raw, BACKOFF_CAP_MS);
}

export interface EventOutboxRow {
  id: string;
  event_id: string;
  event_name: string;
  aggregate_id: string;
  payload: unknown;
  metadata: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
}

export interface ClaimDueInput {
  limit: number;
  now: Date;
  leaseMs: number;
}

export interface MarkFailedInput {
  id: string;
  attempts: number;
  status: OutboxStatus;
  nextAttemptAt: Date | null;
}

export interface EventOutboxRepository {
  /**
   * Persist an envelope as PENDING. The Drizzle implementation MUST run on the
   * caller-provided transaction handle so a business rollback also rolls the
   * outbox row back. There is no autocommit fallback.
   */
  enqueue(envelope: TypedEventEnvelope<EventName>): Promise<void>;
  /** Atomically claim up to `limit` due PENDING or expired CLAIMED rows. */
  claimDue(input: ClaimDueInput): Promise<EventOutboxRow[]>;
  /** DELETE a successfully published row. */
  markPublished(id: string): Promise<void>;
  /** Record a publish failure: attempts/status/next_attempt_at transition. */
  markFailed(input: MarkFailedInput): Promise<void>;
  /** Outstanding (non-DEAD) row count for bounded observability. */
  outstandingCount(): Promise<number>;
}

function isoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Maps a raw DB row (Date- or string-timestamped) to the canonical shape. */
export function mapEventOutboxRow(row: Record<string, unknown>): EventOutboxRow {
  return {
    id: row.id as string,
    event_id: row.event_id as string,
    event_name: row.event_name as string,
    aggregate_id: row.aggregate_id as string,
    payload: row.payload,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    status: row.status as OutboxStatus,
    attempts: Number(row.attempts ?? 0),
    next_attempt_at: isoString(row.next_attempt_at),
    created_at: isoString(row.created_at),
  };
}

/**
 * Reconstructs the persisted event envelope for republishing. The event_id is
 * taken verbatim from the row, so a retry NEVER mints a new identity. The
 * original envelope timestamp is not persisted, so the durable creation time
 * is used as a truthful reconstruction.
 */
export function outboxRowToEnvelope(
  row: EventOutboxRow,
): TypedEventEnvelope<EventName> {
  return {
    event_id: row.event_id,
    event_name: row.event_name as EventName,
    aggregate_id: row.aggregate_id,
    timestamp: new Date(row.created_at),
    payload: row.payload,
    metadata: row.metadata,
  } as TypedEventEnvelope<EventName>;
}

export class MemoryEventOutboxRepository implements EventOutboxRepository {
  private rows: EventOutboxRow[] = [];
  private sequence = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async enqueue(envelope: TypedEventEnvelope<EventName>): Promise<void> {
    const now = this.clock().toISOString();
    this.sequence += 1;
    this.rows.push({
      id: `mem-outbox-${this.sequence}`,
      event_id: envelope.event_id,
      event_name: envelope.event_name,
      aggregate_id: envelope.aggregate_id,
      payload: envelope.payload,
      metadata: envelope.metadata ?? {},
      status: "PENDING",
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
    });
  }

  async claimDue({
    limit,
    now,
    leaseMs,
  }: ClaimDueInput): Promise<EventOutboxRow[]> {
    const at = now.getTime();
    const due = this.rows
      .filter(
        (row) =>
          (row.status === "PENDING" || row.status === "CLAIMED") &&
          Date.parse(row.next_attempt_at) <= at,
      )
      .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at))
      .slice(0, Math.max(0, limit));

    const expiry = new Date(at + leaseMs).toISOString();
    for (const row of due) {
      row.status = "CLAIMED";
      row.next_attempt_at = expiry;
    }
    return due.map((row) => ({ ...row }));
  }

  async markPublished(id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== id);
  }

  async markFailed({
    id,
    attempts,
    status,
    nextAttemptAt,
  }: MarkFailedInput): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return;
    row.attempts = attempts;
    row.status = status;
    if (nextAttemptAt) row.next_attempt_at = nextAttemptAt.toISOString();
  }

  async outstandingCount(): Promise<number> {
    return this.rows.filter((row) => row.status !== "DEAD").length;
  }

  /** Test seam: direct read of all rows (including DEAD). */
  _all(): EventOutboxRow[] {
    return this.rows.map((row) => ({ ...row }));
  }
}
