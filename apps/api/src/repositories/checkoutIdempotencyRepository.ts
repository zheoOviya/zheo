import { randomUUID } from "node:crypto";

// ============================================
// Durable consumer checkout idempotency repository
// (ORDER-IDEMPOTENCY-DURABILITY-A2).
//
// The DB uniqueness on (user_id, idempotency_key) is the concurrency
// authority. `claim` never throws on a duplicate key: it returns EXISTS with
// the winning record so the caller can replay or conflict. `attachOrder` and
// `releaseClaim` are only ever invoked inside the checkout transaction (PG) so
// a rollback leaves no claim behind.
// ============================================

export interface CheckoutIdempotencyRecord {
  id: string;
  user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  order_id: string | null;
  created_at: string;
}

export interface ClaimCheckoutIdempotencyInput {
  user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
}

export type CheckoutIdempotencyClaim =
  | { outcome: "CLAIMED"; record: CheckoutIdempotencyRecord }
  | { outcome: "EXISTS"; record: CheckoutIdempotencyRecord };

export interface CheckoutIdempotencyRepository {
  /**
   * Attempts to claim `(user_id, idempotency_key)`.
   * CLAIMED -> this caller inserted the row and owns the checkout.
   * EXISTS  -> a prior/concurrent request owns it; the record carries the
   *            fingerprint and (post-commit) the order id for replay.
   */
  claim(input: ClaimCheckoutIdempotencyInput): Promise<CheckoutIdempotencyClaim>;
  /** Attach the committed order to a claim won by this caller. */
  attachOrder(claimId: string, orderId: string): Promise<void>;
  /** Remove a claim after a failed checkout so the key is not poisoned. */
  releaseClaim(claimId: string): Promise<void>;
  findByUserAndKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutIdempotencyRecord | null>;
  _reset(): void;
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}\u0000${idempotencyKey}`;
}

interface MemoryEntry {
  record: CheckoutIdempotencyRecord;
  completion: Promise<void>;
  resolve: () => void;
}

/**
 * Memory/test implementation. MEMORY_RESTART_DURABLE = NO (in-process only).
 *
 * A claim that is still in flight (order_id null) makes a concurrent claim for
 * the same key await the owner's attach/release before resolving, so a
 * concurrent pair converges on one order instead of racing to two. This is a
 * best-effort in-process mirror of the Postgres unique-index arbitration; it
 * makes no durability claim across process restarts.
 */
export class MemoryCheckoutIdempotencyRepository
  implements CheckoutIdempotencyRepository
{
  private entries = new Map<string, MemoryEntry>();

  async claim(
    input: ClaimCheckoutIdempotencyInput,
  ): Promise<CheckoutIdempotencyClaim> {
    const key = keyOf(input.user_id, input.idempotency_key);

    // Bounded: the owner always attach'es or release's, so at most one wait.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = this.entries.get(key);
      if (!existing) {
        let resolve!: () => void;
        const completion = new Promise<void>((r) => {
          resolve = r;
        });
        const record: CheckoutIdempotencyRecord = {
          id: randomUUID(),
          user_id: input.user_id,
          idempotency_key: input.idempotency_key,
          request_fingerprint: input.request_fingerprint,
          order_id: null,
          created_at: new Date().toISOString(),
        };
        this.entries.set(key, { record, completion, resolve });
        return { outcome: "CLAIMED", record };
      }

      if (existing.record.order_id === null) {
        // In-flight owner: wait for attach/release, then re-resolve.
        await existing.completion;
        continue;
      }

      return { outcome: "EXISTS", record: existing.record };
    }

    throw new Error("checkout_idempotency_in_progress");
  }

  async attachOrder(claimId: string, orderId: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.record.id === claimId) {
        entry.record = { ...entry.record, order_id: orderId };
        entry.resolve();
        return;
      }
    }
  }

  async releaseClaim(claimId: string): Promise<void> {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.record.id === claimId) {
        this.entries.delete(key);
        entry.resolve();
        return;
      }
    }
  }

  async findByUserAndKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutIdempotencyRecord | null> {
    return this.entries.get(keyOf(userId, idempotencyKey))?.record ?? null;
  }

  _reset(): void {
    this.entries.clear();
  }
}
