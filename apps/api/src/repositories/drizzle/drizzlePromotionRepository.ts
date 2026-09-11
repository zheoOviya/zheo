import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { promotions } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  CreatePromotionInput,
  DiscountType,
  PromotionDTO,
  PromotionRepository,
} from "../promotionRepository";

// ============================================
// Promotion catalog (V09 Promotions Builder) - Drizzle/Postgres.
//
// Mirrors MemoryPromotionRepository semantics exactly: `create` mints the row
// (is_active=true) and returns the full PromotionDTO; `listActive` returns only
// active, unexpired promotions ordered created_at DESC (Memory parity; id ASC
// breaks equal-timestamp ties deterministically), capturing `now` once so the
// `valid_until >= now` boundary stays active. `value` is stored as unconstrained
// numeric and mapped Number() on read / String() on write, matching the loyalty
// repository convention, so no scale rounding occurs. The catalog is global and
// unscoped by design (accepted pre-existing product limitation): no
// restaurant/vendor scoping is introduced here.
// ============================================

/** Drizzle's select builder surface is hidden by the shared DrizzleDb facade,
 *  so the DB-side ordering chain is reached through a narrow local type instead
 *  of widening the shared facade (same approach as role/groupCart repos). */
type OrderedSelect = Promise<unknown[]> & {
  orderBy: (...columns: unknown[]) => OrderedSelect;
};

export class DrizzlePromotionRepository implements PromotionRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapPromotion(row: Record<string, unknown>): PromotionDTO {
    return {
      id: row.id as string,
      title: row.title as string,
      discount_type: row.discount_type as DiscountType,
      value: Number(row.value),
      valid_until: (row.valid_until as Date).toISOString(),
      is_active: row.is_active as boolean,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  async create(input: CreatePromotionInput): Promise<PromotionDTO> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(promotions).values({
      id,
      title: input.title,
      discount_type: input.discount_type,
      value: String(input.value),
      valid_until: new Date(input.valid_until),
      is_active: true,
      created_at: now,
    });
    // Return the same observable DTO the Memory repo constructs: value
    // preserved as the caller's number, valid_until verbatim.
    return {
      id,
      title: input.title,
      discount_type: input.discount_type,
      value: input.value,
      valid_until: input.valid_until,
      is_active: true,
      created_at: now.toISOString(),
    };
  }

  async listActive(): Promise<PromotionDTO[]> {
    // Capture `now` once (app clock) so `valid_until == now` remains active,
    // matching Memory's `Date.parse(valid_until) >= Date.now()`.
    const now = new Date();
    const rows = await (
      this.db
        .select()
        .from(promotions)
        .where(
          and(
            eq(promotions.is_active, true),
            gte(promotions.valid_until, now),
          ),
        ) as unknown as OrderedSelect
    ).orderBy(desc(promotions.created_at), asc(promotions.id));
    return (rows as Record<string, unknown>[]).map((row) => this.mapPromotion(row));
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
