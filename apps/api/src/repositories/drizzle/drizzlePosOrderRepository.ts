import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { pos_order_mappings } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type { OrderRepository } from "../orderRepository";
import type {
  PosImportTransactionPort,
  PosOrderMapping,
  PosOrderRepository,
} from "../posRepository";
import { DrizzlePosImportTransactionPort } from "./posImportTransactionPort";

// ============================================
// POS order mapping (Petpooja integration) - Drizzle/Postgres.
//
// Mirrors MemoryPosOrderRepository semantics exactly: `recordOrder` inserts
// the mapping and returns the same observable DTO; `getByPosOrderId` reads by
// the RESTAURANT-SCOPED identity (restaurant_id + pos_order_id) so the same
// POS order id under a different restaurant never collides.
//
// DB errors are intentionally NOT translated here: the composite unique index
// `pos_order_mappings_restaurant_pos_uq` is the idempotency authority and its
// 23505 is handled by the import flow via isPosOrderMappingDuplicate(); every
// other error propagates untouched.
// ============================================

function rowsOf(result: unknown): Record<string, unknown>[] {
  return result as Record<string, unknown>[];
}

export class DrizzlePosOrderRepository implements PosOrderRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapMapping(row: Record<string, unknown>): PosOrderMapping {
    return {
      id: row.id as string,
      pos_order_id: row.pos_order_id as string,
      order_id: row.order_id as string,
      restaurant_id: row.restaurant_id as string,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  async recordOrder(
    restaurantId: string,
    posOrderId: string,
    orderId: string,
  ): Promise<PosOrderMapping> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(pos_order_mappings).values({
      id,
      pos_order_id: posOrderId,
      order_id: orderId,
      restaurant_id: restaurantId,
      created_at: now,
    });
    // Return the same observable DTO the Memory repo constructs.
    return {
      id,
      pos_order_id: posOrderId,
      order_id: orderId,
      restaurant_id: restaurantId,
      created_at: now.toISOString(),
    };
  }

  async getByPosOrderId(
    restaurantId: string,
    posOrderId: string,
  ): Promise<PosOrderMapping | null> {
    const rows = rowsOf(
      await this.db
        .select()
        .from(pos_order_mappings)
        .where(
          and(
            eq(pos_order_mappings.restaurant_id, restaurantId),
            eq(pos_order_mappings.pos_order_id, posOrderId),
          ),
        ),
    );
    const row = rows[0];
    return row ? this.mapMapping(row) : null;
  }

  transactionPort(_orders: OrderRepository): PosImportTransactionPort {
    return new DrizzlePosImportTransactionPort(this.db);
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
