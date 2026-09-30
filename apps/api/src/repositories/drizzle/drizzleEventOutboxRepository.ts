import { and, asc, eq, inArray, lte, ne, or } from "drizzle-orm";
import { event_outbox } from "@snakzap/db";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DrizzleDb } from "../../lib/dbType";
import {
  mapEventOutboxRow,
  type ClaimDueInput,
  type EventOutboxRepository,
  type EventOutboxRow,
  type MarkFailedInput,
} from "../eventOutboxRepository";

// ============================================
// Durable event outbox repository (Drizzle/Postgres) — EVT-B1.
//
// CLAIM_SOURCE_OF_TRUTH = POSTGRES. Claiming uses
//   SELECT ... FOR UPDATE SKIP LOCKED
// followed by
//   UPDATE ... SET status='CLAIMED', next_attempt_at=<lease>
// inside ONE transaction, so two concurrent relay workers can never claim the
// same due row. No process-local mutex or Redis lock participates.
//
// The shared DrizzleDb facade models only the simple select/update chains, so
// the richer claim chain (orderBy/limit/for skipLocked) is reached through the
// same narrowly-scoped cast pattern used by other repositories.
// ============================================

type RichLimited = Promise<unknown[]> & {
  for: (
    lock: "update",
    opts?: { skipLocked?: boolean },
  ) => Promise<unknown[]>;
};
type RichOrdered = Promise<unknown[]> & {
  limit: (count: number) => RichLimited;
};
type RichRows = Promise<unknown[]> & {
  orderBy: (...columns: unknown[]) => RichOrdered;
};

type DrizzleLike = {
  select: () => {
    from: (table: unknown) => {
      where: (cond: unknown) => RichRows;
    };
  };
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (cond: unknown) => Promise<unknown[]>;
    };
  };
  insert: (table: unknown) => {
    values: (
      values: Record<string, unknown>,
    ) => { onConflictDoNothing: () => Promise<unknown[]> };
  };
  delete: (table: unknown) => {
    where: (cond: unknown) => Promise<unknown[]>;
  };
  transaction: <T>(fn: (tx: DrizzleLike) => Promise<T>) => Promise<T>;
};

export class DrizzleEventOutboxRepository implements EventOutboxRepository {
  constructor(private readonly db: DrizzleDb) {}

  async enqueue(envelope: TypedEventEnvelope<EventName>): Promise<void> {
    const db = this.db as unknown as DrizzleLike;
    await db
      .insert(event_outbox)
      .values({
        event_id: envelope.event_id,
        event_name: envelope.event_name,
        aggregate_id: envelope.aggregate_id,
        payload: envelope.payload,
        metadata: envelope.metadata ?? {},
        status: "PENDING",
        attempts: 0,
      })
      .onConflictDoNothing();
  }

  async claimDue({
    limit,
    now,
    leaseMs,
  }: ClaimDueInput): Promise<EventOutboxRow[]> {
    const db = this.db as unknown as DrizzleLike;
    const leaseExpiry = new Date(now.getTime() + leaseMs);

    return db.transaction(async (tx) => {
      const due = (await tx
        .select()
        .from(event_outbox)
        .where(
          or(
            and(eq(event_outbox.status, "PENDING"), lte(event_outbox.next_attempt_at, now)),
            and(eq(event_outbox.status, "CLAIMED"), lte(event_outbox.next_attempt_at, now)),
          ),
        )
        .orderBy(asc(event_outbox.next_attempt_at))
        .limit(limit)
        .for("update", { skipLocked: true })) as Record<string, unknown>[];

      if (due.length === 0) return [];

      const ids = due.map((row) => row.id as string);
      await tx
        .update(event_outbox)
        .set({ status: "CLAIMED", next_attempt_at: leaseExpiry })
        .where(inArray(event_outbox.id, ids));

      return due.map((row) =>
        mapEventOutboxRow({ ...row, status: "CLAIMED", next_attempt_at: leaseExpiry }),
      );
    });
  }

  async markPublished(id: string): Promise<void> {
    const db = this.db as unknown as DrizzleLike;
    await db.delete(event_outbox).where(eq(event_outbox.id, id));
  }

  async markFailed({
    id,
    attempts,
    status,
    nextAttemptAt,
  }: MarkFailedInput): Promise<void> {
    const db = this.db as unknown as DrizzleLike;
    const values: Record<string, unknown> = { attempts, status };
    if (nextAttemptAt) values.next_attempt_at = nextAttemptAt;
    await db.update(event_outbox).set(values).where(eq(event_outbox.id, id));
  }

  async outstandingCount(): Promise<number> {
    const db = this.db as unknown as DrizzleLike;
    const rows = (await db
      .select()
      .from(event_outbox)
      .where(ne(event_outbox.status, "DEAD"))) as unknown[];
    return rows.length;
  }
}

/**
 * Transactional outbox enqueue primitive (EVT-B1).
 *
 * MUST be called with the caller's existing transaction handle: the insert
 * shares that transaction and rolls back with the business mutation. This
 * helper deliberately never opens its own transaction and has no autocommit
 * fallback.
 */
export async function enqueueDomainEvent(
  tx: DrizzleDb,
  envelope: TypedEventEnvelope<EventName>,
): Promise<void> {
  await new DrizzleEventOutboxRepository(tx).enqueue(envelope);
}
