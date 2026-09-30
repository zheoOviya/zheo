import { and, eq } from "drizzle-orm";
import { event_consumer_dedup } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type { EventConsumerDedupRepository } from "../eventConsumerDedupRepository";

// ============================================
// Durable event-consumer dedup inbox (Drizzle/Postgres) — EVT-C1.
//
// The composite PRIMARY KEY (consumer_name, event_id) is the concurrency
// authority: `markProcessed` uses INSERT ... ON CONFLICT DO NOTHING, so a
// duplicate pair is a no-op and never throws. No process-local mutex
// participates.
//
// TX SCOPING IS THE POINT: construct this repository with the caller's
// transaction handle (or call `markProcessedInTx`) so the marker commits or
// rolls back together with the business effect it guards. This class has no
// autocommit fallback of its own; a standalone `markProcessed` on the pool is
// NOT a production consumer flow.
// ============================================

type DrizzleLike = {
  select: () => {
    from: (table: unknown) => {
      where: (cond: unknown) => Promise<unknown[]>;
    };
  };
  insert: (table: unknown) => {
    values: (
      values: Record<string, unknown>,
    ) => { onConflictDoNothing: () => Promise<unknown[]> };
  };
};

export class DrizzleEventConsumerDedupRepository
  implements EventConsumerDedupRepository
{
  constructor(private readonly db: DrizzleDb) {}

  async hasProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const db = this.db as unknown as DrizzleLike;
    const rows = await db
      .select()
      .from(event_consumer_dedup)
      .where(
        and(
          eq(event_consumer_dedup.consumer_name, consumerName),
          eq(event_consumer_dedup.event_id, eventId),
        ),
      );
    return rows.length > 0;
  }

  async markProcessed(consumerName: string, eventId: string): Promise<void> {
    const db = this.db as unknown as DrizzleLike;
    await db
      .insert(event_consumer_dedup)
      .values({ consumer_name: consumerName, event_id: eventId })
      .onConflictDoNothing();
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}

/**
 * Transactional dedup-marker primitive (EVT-C1).
 *
 * MUST be called with the caller's existing transaction handle so the marker
 * shares that transaction and rolls back with the business effect. Deliberately
 * never opens its own transaction and has no autocommit fallback.
 */
export async function markProcessedInTx(
  tx: DrizzleDb,
  consumerName: string,
  eventId: string,
): Promise<void> {
  await new DrizzleEventConsumerDedupRepository(tx).markProcessed(
    consumerName,
    eventId,
  );
}

/** Read the marker on the caller's transaction handle (same tx scope). */
export async function hasProcessedInTx(
  tx: DrizzleDb,
  consumerName: string,
  eventId: string,
): Promise<boolean> {
  return new DrizzleEventConsumerDedupRepository(tx).hasProcessed(
    consumerName,
    eventId,
  );
}
