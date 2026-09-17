import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { notifications } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

/**
 * Drizzle update chain result exposing `.returning()`. The shared `DrizzleDb`
 * type only models the awaited form, so correctness paths cast the chain the
 * same way `vendorApplicationRepository` does.
 */
type ReturningUpdate = {
  returning: () => Promise<unknown[]>;
};

/**
 * Drizzle aggregate select chain. The shared `DrizzleDb` facade only models
 * plain `select()` row reads, so the DB-side aggregate query is reached through
 * the same targeted cast used for `.returning()` above.
 */
type AggregateSelect = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => Promise<Record<string, unknown>[]>;
  };
};

/**
 * Drizzle aggregate select chain that also supports `GROUP BY`. `.where()`,
 * `.groupBy()`, and `.orderBy()` each return the same awaitable query, so a
 * `group by` aggregate is reached through one bounded cast instead of
 * materializing rows. Used by the PII-free channel/failure-category health
 * read model.
 */
type AggregateGroupQuery = Promise<Record<string, unknown>[]> & {
  where: (condition: unknown) => AggregateGroupQuery;
  groupBy: (...columns: unknown[]) => AggregateGroupQuery;
  orderBy: (...columns: unknown[]) => AggregateGroupQuery;
};

type AggregateGroupSelect = {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => AggregateGroupQuery;
  };
};

// ============================================
// Notification outbox repository (transactional messaging)
// Best-effort delivery: subscribers enqueue here; a drain step reserves an
// attempt, invokes the provider, then CAS-transitions from the exact reserved
// attempt.
//
// Attempt semantics (NOTIFICATION-DELIVERY-CONCURRENCY-A2): `attempts` counts
// provider attempts reserved/invoked. It is incremented atomically by
// `reserveAttempt` BEFORE any provider call; the terminal/retry writes never
// increment it and only succeed while the row is still PENDING at the exact
// reserved attempt. A stale worker therefore cannot duplicate a send or
// regress a SENT/FAILED row.
// ============================================

export type NotificationChannel = "sms" | "email";
export type NotificationStatus = "PENDING" | "SENT" | "FAILED";

/** Retry/dead policy boundary, shared with the delivery service. */
export const NOTIFICATION_MAX_ATTEMPTS = 5;

export interface NotificationDTO {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  to_address: string;
  body: string;
  status: NotificationStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
}

export interface EnqueueNotificationInput {
  user_id: string;
  channel: NotificationChannel;
  to_address: string;
  body: string;
}

/**
 * PII-free aggregate operability metrics (NOTIFICATION-OPERABILITY-A2).
 *
 * Counts and extrema only. The shape deliberately excludes `body`,
 * `to_address`, `last_error`, and `user_id` so an operator read surface can
 * never leak row-level notification content. `oldest_pending_at` and
 * `max_attempt_pending` are nullable because an empty PENDING set has no
 * minimum/maximum; they must never be fabricated as 0/null-adjacent values.
 *
 * All classification is resolved against ONE caller-supplied `now` so
 * `pending_total = due_pending + future_retry` holds for a single evaluation
 * instant.
 */
export interface NotificationOperabilityMetrics {
  pending_total: number;
  due_pending: number;
  future_retry: number;
  failed_total: number;
  sent_total: number;
  oldest_pending_at: string | null;
  max_attempt_pending: number | null;
}

/**
 * Closed, privacy-safe failure taxonomy (NOTIFICATION-OPERABILITY-READMODEL-A2
 * V1). Raw provider/error text never leaves the server. `PROVIDER_UNCONFIGURED`
 * is the only grounded category today; anything not provably in it is `UNKNOWN`.
 * Speculative categories (timeout/rejected/transient/DB-conflict) are deliberately
 * absent because no real persisted production path produces them yet.
 */
export type SafeErrorCategory = "PROVIDER_UNCONFIGURED" | "UNKNOWN";

/**
 * Exact persisted `CONFIG_ERROR` texts emitted by the delivery service when no
 * provider adapter is configured. Keep in sync with the SQL `CASE` in
 * `DrizzleNotificationRepository.getOperabilityHealth`; memory/Drizzle parity
 * tests guard against drift. Membership is exact equality on purpose: substring
 * families would pretend a provider adapter exists.
 */
const PROVIDER_UNCONFIGURED_ERRORS: ReadonlySet<string> = new Set([
  "sms provider not configured",
  "email provider not configured",
]);

/**
 * Normalize a persisted `last_error` into the closed safe enum. `null` means the
 * row has no recorded failure and contributes no category. Exported so the
 * mapping is directly unit-testable.
 */
export function classifyNotificationError(lastError: string | null): SafeErrorCategory | null {
  if (lastError === null) return null;
  return PROVIDER_UNCONFIGURED_ERRORS.has(lastError) ? "PROVIDER_UNCONFIGURED" : "UNKNOWN";
}

/** Per-channel aggregate delivery state. Counts are non-negative integers. */
export interface NotificationChannelHealth {
  channel: NotificationChannel;
  pending: number;
  due: number;
  failed: number;
  sent: number;
}

/** Per-channel safe failure-category aggregate. Never carries raw error text. */
export interface NotificationFailureCategoryHealth {
  channel: NotificationChannel;
  safe_error_category: SafeErrorCategory;
  count: number;
}

/**
 * PII-free aggregate operator health read model. `channels` covers every
 * channel actually represented in storage (never fabricated) and
 * `failure_categories` counts only records with a recorded failure (terminal
 * FAILED rows and currently-retryable PENDING rows carrying `last_error`).
 * Ordering is deterministic (channel asc, then category asc) so responses are
 * stable. No row identifiers, recipients, bodies, or raw errors are included.
 */
export interface NotificationOperabilityHealth {
  channels: NotificationChannelHealth[];
  failure_categories: NotificationFailureCategoryHealth[];
}

export interface NotificationRepository {
  enqueue(input: EnqueueNotificationInput): Promise<NotificationDTO>;
  listAll(limit?: number): Promise<NotificationDTO[]>;
  listPending(limit?: number): Promise<NotificationDTO[]>;
  /**
   * PII-free aggregate backlog/failure health for operators. Resolves every
   * metric against the single supplied `now` (never an internal `new Date()`),
   * so `pending_total === due_pending + future_retry` and the oldest-pending
   * age share one consistent clock. A `next_attempt_at` exactly equal to `now`
   * counts as DUE, not future.
   */
  getOperabilityMetrics(now: Date): Promise<NotificationOperabilityMetrics>;
  /**
   * Read-only, PII-free aggregate channel/failure health for operators. Counts
   * the same due partition as `getOperabilityMetrics` against the single
   * supplied `now` (a `next_attempt_at` exactly equal to `now` is DUE) and
   * reports safe, closed-enum failure categories. Performs no mutation and
   * exposes no per-record data.
   */
  getOperabilityHealth(now: Date): Promise<NotificationOperabilityHealth>;
  /**
   * Atomically reserve one delivery attempt: CAS over
   * id + status=PENDING + next_attempt_at<=now + attempts=expectedAttempts +
   * attempts<MAX, incrementing attempts exactly once. Returns the reserved row
   * (authoritative post-increment attempts) or null when another worker won,
   * the row is ineligible, or it is already terminal.
   */
  reserveAttempt(
    id: string,
    expectedAttempts: number,
    now: Date,
  ): Promise<NotificationDTO | null>;
  /** PENDING -> SENT, but only for the exact reserved attempt. No increment. */
  markSent(id: string, reservedAttempts: number): Promise<NotificationDTO | null>;
  /** Stays PENDING, recording error + backoff for the exact reserved attempt. */
  markRetryable(
    id: string,
    reservedAttempts: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<NotificationDTO | null>;
  /** PENDING -> FAILED, but only for the exact reserved attempt. No increment. */
  markDead(
    id: string,
    reservedAttempts: number,
    error: string,
  ): Promise<NotificationDTO | null>;
  _reset(): void;
}

export class MemoryNotificationRepository implements NotificationRepository {
  private readonly items = new Map<string, NotificationDTO>();

  async enqueue(input: EnqueueNotificationInput): Promise<NotificationDTO> {
    const now = new Date().toISOString();
    const n: NotificationDTO = {
      id: randomUUID(),
      user_id: input.user_id,
      channel: input.channel,
      to_address: input.to_address,
      body: input.body,
      status: "PENDING",
      attempts: 0,
      last_error: null,
      next_attempt_at: now,
      created_at: now,
    };
    this.items.set(n.id, n);
    return n;
  }

  async listAll(limit = 200): Promise<NotificationDTO[]> {
    return Array.from(this.items.values())
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  async listPending(limit = 50): Promise<NotificationDTO[]> {
    const now = Date.now();
    return Array.from(this.items.values())
      .filter((n) => n.status === "PENDING" && new Date(n.next_attempt_at).getTime() <= now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  async getOperabilityMetrics(now: Date): Promise<NotificationOperabilityMetrics> {
    const nowMs = now.getTime();
    let pending_total = 0;
    let due_pending = 0;
    let future_retry = 0;
    let failed_total = 0;
    let sent_total = 0;
    let oldest_pending_at: string | null = null;
    let max_attempt_pending: number | null = null;
    for (const n of this.items.values()) {
      if (n.status === "PENDING") {
        pending_total += 1;
        if (new Date(n.next_attempt_at).getTime() <= nowMs) due_pending += 1;
        else future_retry += 1;
        if (oldest_pending_at === null || n.created_at < oldest_pending_at) {
          oldest_pending_at = n.created_at;
        }
        if (max_attempt_pending === null || n.attempts > max_attempt_pending) {
          max_attempt_pending = n.attempts;
        }
      } else if (n.status === "FAILED") {
        failed_total += 1;
      } else if (n.status === "SENT") {
        sent_total += 1;
      }
    }
    return {
      pending_total,
      due_pending,
      future_retry,
      failed_total,
      sent_total,
      oldest_pending_at,
      max_attempt_pending,
    };
  }

  async getOperabilityHealth(now: Date): Promise<NotificationOperabilityHealth> {
    const nowMs = now.getTime();
    const byChannel = new Map<NotificationChannel, NotificationChannelHealth>();
    // Keyed `${channel}\u0000${category}` so the two aggregate dimensions stay
    // independent without nested maps.
    const failureCounts = new Map<string, number>();
    for (const n of this.items.values()) {
      let health = byChannel.get(n.channel);
      if (!health) {
        health = { channel: n.channel, pending: 0, due: 0, failed: 0, sent: 0 };
        byChannel.set(n.channel, health);
      }
      if (n.status === "PENDING") {
        health.pending += 1;
        if (new Date(n.next_attempt_at).getTime() <= nowMs) health.due += 1;
      } else if (n.status === "FAILED") {
        health.failed += 1;
      } else if (n.status === "SENT") {
        health.sent += 1;
      }

      const category = classifyNotificationError(n.last_error);
      if (category !== null) {
        const key = `${n.channel}\u0000${category}`;
        failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
      }
    }
    const channels = Array.from(byChannel.values()).sort((a, b) =>
      a.channel.localeCompare(b.channel),
    );
    const failure_categories = Array.from(failureCounts.entries())
      .map(([key, count]) => {
        const [channel, safe_error_category] = key.split("\u0000") as [
          NotificationChannel,
          SafeErrorCategory,
        ];
        return { channel, safe_error_category, count };
      })
      .sort(
        (a, b) =>
          a.channel.localeCompare(b.channel) ||
          a.safe_error_category.localeCompare(b.safe_error_category),
      );
    return { channels, failure_categories };
  }

  async reserveAttempt(
    id: string,
    expectedAttempts: number,
    now: Date,
  ): Promise<NotificationDTO | null> {
    const n = this.items.get(id);
    if (!n) return null;
    if (n.status !== "PENDING") return null;
    if (new Date(n.next_attempt_at).getTime() > now.getTime()) return null;
    if (n.attempts !== expectedAttempts) return null;
    if (n.attempts >= NOTIFICATION_MAX_ATTEMPTS) return null;
    // Mutate synchronously so concurrent callers cannot both win.
    const reserved: NotificationDTO = { ...n, attempts: n.attempts + 1 };
    this.items.set(id, reserved);
    return reserved;
  }

  async markSent(id: string, reservedAttempts: number): Promise<NotificationDTO | null> {
    const n = this.items.get(id);
    if (!n || n.status !== "PENDING" || n.attempts !== reservedAttempts) return null;
    const next: NotificationDTO = { ...n, status: "SENT", last_error: null };
    this.items.set(id, next);
    return next;
  }

  async markRetryable(
    id: string,
    reservedAttempts: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<NotificationDTO | null> {
    const n = this.items.get(id);
    if (!n || n.status !== "PENDING" || n.attempts !== reservedAttempts) return null;
    const next: NotificationDTO = {
      ...n,
      status: "PENDING",
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
    };
    this.items.set(id, next);
    return next;
  }

  async markDead(
    id: string,
    reservedAttempts: number,
    error: string,
  ): Promise<NotificationDTO | null> {
    const n = this.items.get(id);
    if (!n || n.status !== "PENDING" || n.attempts !== reservedAttempts) return null;
    const next: NotificationDTO = { ...n, status: "FAILED", last_error: error };
    this.items.set(id, next);
    return next;
  }

  _reset(): void {
    this.items.clear();
  }
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRow(row: Record<string, unknown>): NotificationDTO {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      channel: row.channel as NotificationChannel,
      to_address: row.to_address as string,
      body: row.body as string,
      status: row.status as NotificationStatus,
      attempts: Number(row.attempts ?? 0),
      last_error: (row.last_error as string | null) ?? null,
      next_attempt_at: (row.next_attempt_at as Date).toISOString(),
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  async enqueue(input: EnqueueNotificationInput): Promise<NotificationDTO> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(notifications).values({
      id,
      user_id: input.user_id,
      channel: input.channel,
      to_address: input.to_address,
      body: input.body,
    });
    return {
      id,
      user_id: input.user_id,
      channel: input.channel,
      to_address: input.to_address,
      body: input.body,
      status: "PENDING",
      attempts: 0,
      last_error: null,
      next_attempt_at: now.toISOString(),
      created_at: now.toISOString(),
    };
  }

  async listAll(limit = 200): Promise<NotificationDTO[]> {
    const rows = (await this.db
      .select()
      .from(notifications)
      .where(undefined)) as Record<string, unknown>[];
    return rows
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  async listPending(limit = 50): Promise<NotificationDTO[]> {
    const rows = (await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "PENDING"),
          lte(notifications.next_attempt_at, new Date()),
        ),
      )) as Record<string, unknown>[];
    return rows
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  async getOperabilityMetrics(now: Date): Promise<NotificationOperabilityMetrics> {
    // Single database-side aggregate: counts are computed with
    // `count(*) FILTER`, extrema with MIN/MAX, so no notification row (and no
    // PII column) is ever selected into application memory. The one fixed
    // `now` parameter classifies due vs. future for the whole read.
    const rows = (await (
      this.db as unknown as AggregateSelect
    )
      .select({
        pending_total: sql<number>`count(*) filter (where ${notifications.status} = ${"PENDING"})`,
        due_pending: sql<number>`count(*) filter (where ${notifications.status} = ${"PENDING"} and ${notifications.next_attempt_at} <= ${now})`,
        future_retry: sql<number>`count(*) filter (where ${notifications.status} = ${"PENDING"} and ${notifications.next_attempt_at} > ${now})`,
        failed_total: sql<number>`count(*) filter (where ${notifications.status} = ${"FAILED"})`,
        sent_total: sql<number>`count(*) filter (where ${notifications.status} = ${"SENT"})`,
        oldest_pending_at: sql<Date | null>`min(${notifications.created_at}) filter (where ${notifications.status} = ${"PENDING"})`,
        max_attempt_pending: sql<number | null>`max(${notifications.attempts}) filter (where ${notifications.status} = ${"PENDING"})`,
      })
      .from(notifications)) as Record<string, unknown>[];

    const row = rows[0] ?? {};
    const oldest = row.oldest_pending_at;
    const maxAttempts = row.max_attempt_pending;
    return {
      pending_total: Number(row.pending_total ?? 0),
      due_pending: Number(row.due_pending ?? 0),
      future_retry: Number(row.future_retry ?? 0),
      failed_total: Number(row.failed_total ?? 0),
      sent_total: Number(row.sent_total ?? 0),
      oldest_pending_at: oldest ? new Date(oldest as string | Date).toISOString() : null,
      max_attempt_pending:
        maxAttempts === null || maxAttempts === undefined ? null : Number(maxAttempts),
    };
  }

  async getOperabilityHealth(now: Date): Promise<NotificationOperabilityHealth> {
    // Two bounded DB-side aggregates: one groups delivery state by channel, the
    // other groups failure records by channel + closed-enum safe category. The
    // CASE keeps raw `last_error` in the database: only the normalized enum and
    // integer counts cross into application memory, and no row is materialized.
    const safeErrorCategory = sql<string>`case when ${notifications.last_error} in (${"sms provider not configured"}, ${"email provider not configured"}) then ${"PROVIDER_UNCONFIGURED"} else ${"UNKNOWN"} end`;

    const channelRows = (await (this.db as unknown as AggregateGroupSelect)
      .select({
        channel: notifications.channel,
        pending: sql<number>`count(*) filter (where ${notifications.status} = ${"PENDING"})`,
        due: sql<number>`count(*) filter (where ${notifications.status} = ${"PENDING"} and ${notifications.next_attempt_at} <= ${now})`,
        failed: sql<number>`count(*) filter (where ${notifications.status} = ${"FAILED"})`,
        sent: sql<number>`count(*) filter (where ${notifications.status} = ${"SENT"})`,
      })
      .from(notifications)
      .groupBy(notifications.channel)
      .orderBy(notifications.channel)) as Record<string, unknown>[];

    const failureRows = (await (this.db as unknown as AggregateGroupSelect)
      .select({
        channel: notifications.channel,
        safe_error_category: safeErrorCategory,
        count: sql<number>`count(*)`,
      })
      .from(notifications)
      .where(isNotNull(notifications.last_error))
      .groupBy(notifications.channel, safeErrorCategory)
      .orderBy(notifications.channel, safeErrorCategory)) as Record<string, unknown>[];

    return {
      channels: channelRows.map((row) => ({
        channel: row.channel as NotificationChannel,
        pending: Number(row.pending ?? 0),
        due: Number(row.due ?? 0),
        failed: Number(row.failed ?? 0),
        sent: Number(row.sent ?? 0),
      })),
      failure_categories: failureRows.map((row) => ({
        channel: row.channel as NotificationChannel,
        safe_error_category: row.safe_error_category as SafeErrorCategory,
        count: Number(row.count ?? 0),
      })),
    };
  }

  async reserveAttempt(
    id: string,
    expectedAttempts: number,
    now: Date,
  ): Promise<NotificationDTO | null> {
    const rows = (await (
      this.db
        .update(notifications)
        .set({ attempts: sql`${notifications.attempts} + 1` })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.status, "PENDING"),
            lte(notifications.next_attempt_at, now),
            eq(notifications.attempts, expectedAttempts),
            lt(notifications.attempts, NOTIFICATION_MAX_ATTEMPTS),
          ),
        ) as unknown as ReturningUpdate
    ).returning()) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async markSent(id: string, reservedAttempts: number): Promise<NotificationDTO | null> {
    const rows = (await (
      this.db
        .update(notifications)
        .set({ status: "SENT", last_error: null })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.status, "PENDING"),
            eq(notifications.attempts, reservedAttempts),
          ),
        ) as unknown as ReturningUpdate
    ).returning()) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async markRetryable(
    id: string,
    reservedAttempts: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<NotificationDTO | null> {
    const rows = (await (
      this.db
        .update(notifications)
        .set({ status: "PENDING", last_error: error, next_attempt_at: nextAttemptAt })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.status, "PENDING"),
            eq(notifications.attempts, reservedAttempts),
          ),
        ) as unknown as ReturningUpdate
    ).returning()) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  async markDead(
    id: string,
    reservedAttempts: number,
    error: string,
  ): Promise<NotificationDTO | null> {
    const rows = (await (
      this.db
        .update(notifications)
        .set({ status: "FAILED", last_error: error })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.status, "PENDING"),
            eq(notifications.attempts, reservedAttempts),
          ),
        ) as unknown as ReturningUpdate
    ).returning()) as Record<string, unknown>[];
    const row = rows[0];
    return row ? this.mapRow(row) : null;
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
