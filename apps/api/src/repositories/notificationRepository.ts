import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { notifications } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// Notification outbox repository (transactional messaging)
// Best-effort delivery: subscribers enqueue here; a drain step sends and
// marks SENT, or backs off a retry via next_attempt_at until the entry is
// declared dead (FAILED) after MAX_ATTEMPTS.
// ============================================

export type NotificationChannel = "sms" | "email";
export type NotificationStatus = "PENDING" | "SENT" | "FAILED";

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
  markSent(id: string): Promise<void>;
  /** Record a failed attempt but keep the entry retryable (stays PENDING). */
  markRetryable(id: string, error: string, nextAttemptAt: Date): Promise<void>;
  /** Terminal failure after MAX_ATTEMPTS (status FAILED). */
  markDead(id: string, error: string): Promise<void>;
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

  async markSent(id: string): Promise<void> {
    const n = this.items.get(id);
    if (!n) return;
    this.items.set(id, { ...n, status: "SENT", attempts: n.attempts + 1, last_error: null });
  }

  async markRetryable(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    const n = this.items.get(id);
    if (!n) return;
    this.items.set(id, {
      ...n,
      status: "PENDING",
      attempts: n.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
    });
  }

  async markDead(id: string, error: string): Promise<void> {
    const n = this.items.get(id);
    if (!n) return;
    this.items.set(id, { ...n, status: "FAILED", attempts: n.attempts + 1, last_error: error });
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

  async markSent(id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ status: "SENT", last_error: null })
      .where(eq(notifications.id, id));
  }

  async markRetryable(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .update(notifications)
      .set({ status: "PENDING", last_error: error, next_attempt_at: nextAttemptAt })
      .where(eq(notifications.id, id));
  }

  async markDead(id: string, error: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ status: "FAILED", last_error: error })
      .where(eq(notifications.id, id));
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
