import { randomUUID } from "node:crypto";
import type { OrderRepository } from "./orderRepository";

// ============================================
// POS integration repository (pos bounded context)
// Maps Petpooja's own order number (pos_order_id) to the
// SnakZap order id so retried webhook deliveries never
// create a duplicate order. Same dedup seam as the
// Razorpay webhook (findByRazorpayPaymentId).
//
// Idempotency identity is RESTAURANT-SCOPED: the same
// pos_order_id may legitimately exist under two different
// restaurants, so every lookup/insert is keyed by
// (restaurant_id, pos_order_id). The DB unique index
// `pos_order_mappings_restaurant_pos_uq` is the final
// authority; the memory repo mirrors it with a nested Map.
// ============================================

export interface PosOrderMapping {
  id: string;
  pos_order_id: string;
  order_id: string;
  restaurant_id: string;
  created_at: string;
}

// ============================================
// POS import transaction port (Petpooja integration).
//
// Freezes the atomic write boundary for a POS import: the internal order
// (with its items/status) and the pos_order_mappings row must commit or roll
// back together, so a crash between the two can never leave a persisted order
// without its idempotency mapping. The port exposes only the operations the
// import flow needs, so no `as unknown as` cast is required at the service
// boundary.
// ============================================

export interface PosImportTxRepos {
  orders: Pick<OrderRepository, "create" | "getById" | "updateStatus">;
  pos: Pick<PosOrderRepository, "recordOrder" | "getByPosOrderId">;
}

export interface PosImportTransactionPort {
  runInTransaction<T>(fn: (repos: PosImportTxRepos) => Promise<T>): Promise<T>;
}

/**
 * Memory-mode transaction port: executes the callback directly against the
 * same in-memory repositories. There is no cross-store crash window in a
 * single process, so the passthrough preserves the existing dev/test
 * semantics.
 */
export class MemoryPosImportTransactionPort implements PosImportTransactionPort {
  constructor(
    private readonly orders: Pick<
      OrderRepository,
      "create" | "getById" | "updateStatus"
    >,
    private readonly pos: Pick<
      PosOrderRepository,
      "recordOrder" | "getByPosOrderId"
    >,
  ) {}

  async runInTransaction<T>(
    fn: (repos: PosImportTxRepos) => Promise<T>,
  ): Promise<T> {
    return fn({ orders: this.orders, pos: this.pos });
  }
}

export interface PosOrderRepository {
  recordOrder(
    restaurantId: string,
    posOrderId: string,
    orderId: string,
  ): Promise<PosOrderMapping>;
  getByPosOrderId(
    restaurantId: string,
    posOrderId: string,
  ): Promise<PosOrderMapping | null>;
  /**
   * Postgres-only: builds a transaction port over the same DB handle so the
   * import flow can write the order and its idempotency mapping atomically.
   * Memory repositories leave this undefined and the service falls back to
   * {@link MemoryPosImportTransactionPort}.
   */
  transactionPort?(orders: OrderRepository): PosImportTransactionPort;
  _reset(): void;
}

/** Exact DB unique index that arbitrates concurrent POS imports. */
export const POS_ORDER_MAPPING_UNIQUE_CONSTRAINT =
  "pos_order_mappings_restaurant_pos_uq";

/** Walks the error cause chain to the Postgres SQLSTATE + constraint name. */
function pgErrorDetails(err: unknown): { code?: string; constraint?: string } {
  let cur = err as
    | { code?: unknown; constraint?: unknown; cause?: unknown }
    | undefined;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (typeof cur.code === "string") {
      return {
        code: cur.code,
        constraint:
          typeof cur.constraint === "string" ? cur.constraint : undefined,
      };
    }
    cur = cur.cause as typeof cur;
  }
  return {};
}

/**
 * TRUE only for the exact POS-mapping idempotency violation. Any other 23505
 * (or any other error) must be rethrown by the caller - broad duplicate
 * swallowing would hide unrelated data-integrity failures.
 */
export function isPosOrderMappingDuplicate(err: unknown): boolean {
  const { code, constraint } = pgErrorDetails(err);
  return code === "23505" && constraint === POS_ORDER_MAPPING_UNIQUE_CONSTRAINT;
}

export class MemoryPosOrderRepository implements PosOrderRepository {
  /**
   * restaurant_id -> pos_order_id -> mapping. Nested, not a concatenated
   * `${restaurantId}:${posOrderId}` string, because a separator collision
   * would alias two distinct identities onto one key.
   */
  private readonly mappings = new Map<string, Map<string, PosOrderMapping>>();

  async recordOrder(
    restaurantId: string,
    posOrderId: string,
    orderId: string,
  ): Promise<PosOrderMapping> {
    const mapping: PosOrderMapping = {
      id: randomUUID(),
      pos_order_id: posOrderId,
      order_id: orderId,
      restaurant_id: restaurantId,
      created_at: new Date().toISOString(),
    };
    let byPosOrderId = this.mappings.get(restaurantId);
    if (!byPosOrderId) {
      byPosOrderId = new Map<string, PosOrderMapping>();
      this.mappings.set(restaurantId, byPosOrderId);
    }
    byPosOrderId.set(posOrderId, mapping);
    return mapping;
  }

  async getByPosOrderId(
    restaurantId: string,
    posOrderId: string,
  ): Promise<PosOrderMapping | null> {
    return this.mappings.get(restaurantId)?.get(posOrderId) ?? null;
  }

  _reset(): void {
    this.mappings.clear();
  }
}
