import { randomUUID } from "node:crypto";

// ============================================
// POS integration repository (pos bounded context)
// Maps Petpooja's own order number (pos_order_id) to the
// SnakZap order id so retried webhook deliveries never
// create a duplicate order. Same dedup seam as the
// Razorpay webhook (findByRazorpayPaymentId).
// ============================================

export interface PosOrderMapping {
  id: string;
  pos_order_id: string;
  order_id: string;
  restaurant_id: string;
  created_at: string;
}

export interface PosOrderRepository {
  recordOrder(
    posOrderId: string,
    orderId: string,
    restaurantId: string,
  ): Promise<PosOrderMapping>;
  getByPosOrderId(posOrderId: string): Promise<PosOrderMapping | null>;
  _reset(): void;
}

export class MemoryPosOrderRepository implements PosOrderRepository {
  private readonly mappings = new Map<string, PosOrderMapping>();

  async recordOrder(
    posOrderId: string,
    orderId: string,
    restaurantId: string,
  ): Promise<PosOrderMapping> {
    const mapping: PosOrderMapping = {
      id: randomUUID(),
      pos_order_id: posOrderId,
      order_id: orderId,
      restaurant_id: restaurantId,
      created_at: new Date().toISOString(),
    };
    this.mappings.set(posOrderId, mapping);
    return mapping;
  }

  async getByPosOrderId(posOrderId: string): Promise<PosOrderMapping | null> {
    return this.mappings.get(posOrderId) ?? null;
  }

  _reset(): void {
    this.mappings.clear();
  }
}
