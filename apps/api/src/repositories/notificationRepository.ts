import { randomUUID } from "node:crypto";
import { and, eq, lt, lte, sql } from "drizzle-orm";
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

export interface NotificationRepository {
  enqueue(input: EnqueueNotificationInput): Promise<NotificationDTO>;
  listAll(limit?: number): Promise<NotificationDTO[]>;
  listPending(limit?: number): Promise<NotificationDTO[]>;
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
