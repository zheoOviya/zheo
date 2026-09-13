import { and, eq } from "drizzle-orm";
import { checkout_idempotency } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  CheckoutIdempotencyClaim,
  CheckoutIdempotencyRecord,
  CheckoutIdempotencyRepository,
  ClaimCheckoutIdempotencyInput,
} from "../checkoutIdempotencyRepository";

// ============================================
// Drizzle/Postgres durable checkout idempotency
// (ORDER-IDEMPOTENCY-DURABILITY-A2).
//
// The composite unique index `checkout_idempotency_user_key_uq` is the arbiter.
// A concurrent claim uses INSERT ... ON CONFLICT DO NOTHING: if a conflicting
// uncommitted row exists Postgres blocks this statement until the winner
// commits/rolls back, so a loser never observes a half-written claim.
// ============================================

/** Narrow query-builder surface for ON CONFLICT ... RETURNING. */
type ConflictInsertChain = {
  values: (values: Record<string, unknown>) => {
    onConflictDoNothing: (config: { target: unknown[] }) => {
      returning: () => Promise<unknown[]>;
    };
  };
};

function mapRecord(row: Record<string, unknown>): CheckoutIdempotencyRecord {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    idempotency_key: row.idempotency_key as string,
    request_fingerprint: row.request_fingerprint as string,
    order_id: (row.order_id as string | null) ?? null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export class DrizzleCheckoutIdempotencyRepository
  implements CheckoutIdempotencyRepository
{
  constructor(private readonly db: DrizzleDb) {}

  async claim(
    input: ClaimCheckoutIdempotencyInput,
  ): Promise<CheckoutIdempotencyClaim> {
    const inserted = (await (this.db.insert(
      checkout_idempotency,
    ) as unknown as ConflictInsertChain)
      .values({
        user_id: input.user_id,
        idempotency_key: input.idempotency_key,
        request_fingerprint: input.request_fingerprint,
      })
      .onConflictDoNothing({
        target: [
          checkout_idempotency.user_id,
          checkout_idempotency.idempotency_key,
        ],
      })
      .returning()) as Record<string, unknown>[];

    if (inserted.length > 0) {
      return {
        outcome: "CLAIMED",
        record: mapRecord(inserted[0] as Record<string, unknown>),
      };
    }

    // Lost the unique race: the winner has committed before our statement
    // unblocked, so the readable row carries the fingerprint and order id.
    const existing = await this.findByUserAndKey(
      input.user_id,
      input.idempotency_key,
    );
    if (!existing) {
      throw new Error("checkout_idempotency_conflict_unreadable");
    }
    return { outcome: "EXISTS", record: existing };
  }

  async attachOrder(claimId: string, orderId: string): Promise<void> {
    await this.db
      .update(checkout_idempotency)
      .set({ order_id: orderId })
      .where(eq(checkout_idempotency.id, claimId));
  }

  async releaseClaim(claimId: string): Promise<void> {
    await this.db
      .delete(checkout_idempotency)
      .where(eq(checkout_idempotency.id, claimId));
  }

  async findByUserAndKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutIdempotencyRecord | null> {
    const rows = (await this.db
      .select()
      .from(checkout_idempotency)
      .where(
        and(
          eq(checkout_idempotency.user_id, userId),
          eq(checkout_idempotency.idempotency_key, idempotencyKey),
        ),
      )) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapRecord(row) : null;
  }

  _reset(): void {
    // No-op: Postgres persistence is not reset in-process.
  }
}
