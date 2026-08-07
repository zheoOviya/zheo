import { randomUUID } from "node:crypto";
import type {
  OrderStatus,
} from "@snakzap/types";
import type { CustomizationDelta } from "../services/pricing";
import type { PriceBreakdown } from "../services/pricing";

// ============================================
// Ordering context repository (ordering bounded context)
// ============================================

export interface OrderItemDTO {
  id: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: CustomizationDelta[];
  customization_total: number;
  item_subtotal: number;
}

export interface OrderDTO {
  id: string;
  user_id: string;
  restaurant_id: string;
  items: OrderItemDTO[];
  total_amount: number;
  status: OrderStatus;
  commission_rate: number;
  commission_amount: number;
  /** W12 (Phase 4): bulk B2B catering order. Always set by create(). */
  is_catering?: boolean;
  /** W12 (Phase 4): event headcount. NULL for standard orders. */
  headcount?: number | null;
  pickup_otp: string | null;
  qr_token: string | null;
  checked_in: boolean;
  scheduled_pickup_time: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOrderInput {
  user_id: string;
  restaurant_id: string;
  items: Omit<OrderItemDTO, "id">[];
  breakdown: PriceBreakdown;
  scheduled_pickup_time?: string;
  is_catering?: boolean;
  headcount?: number | null;
}

export interface OrderRepository {
  create(input: CreateOrderInput): Promise<OrderDTO>;
  getById(orderId: string): Promise<OrderDTO | null>;
  getLatestByUser(userId: string): Promise<OrderDTO | null>;
  getByUser(userId: string): Promise<OrderDTO[]>;
  /** Sprint 1 (I-03): page/limit slice of a user's orders (newest first). */
  getByUserPaginated(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ orders: OrderDTO[]; total: number }>;
  getByRestaurant(restaurantId: string): Promise<OrderDTO[]>;
  getSettlableOrdersByRestaurant(
    restaurantId: string,
    fromIso: string,
    toIso: string,
  ): Promise<OrderDTO[]>;
  updateStatus(orderId: string, status: OrderStatus): Promise<OrderDTO | null>;
  setPickupOtp(orderId: string, otp: string, qrToken: string): Promise<OrderDTO | null>;
  setCheckedIn(orderId: string): Promise<OrderDTO | null>;
  findByQrToken(qrToken: string): Promise<OrderDTO | null>;
  /**
   * O02 group cart: atomically replaces the order's line items and recomputed
   * totals. Used ONLY by the group-order service under its per-token lock so
   * concurrent contributors can never lose an update.
   */
  setItems(
    orderId: string,
    items: Omit<OrderItemDTO, "id">[],
    breakdown: PriceBreakdown,
  ): Promise<OrderDTO | null>;
}

export class MemoryOrderRepository implements OrderRepository {
  private orders = new Map<string, OrderDTO>();

  async create(input: CreateOrderInput): Promise<OrderDTO> {
    const now = new Date().toISOString();
    const order: OrderDTO = {
      id: randomUUID(),
      user_id: input.user_id,
      restaurant_id: input.restaurant_id,
      items: input.items.map((item) => ({
        ...item,
        id: randomUUID(),
      })),
      total_amount: input.breakdown.total_amount,
      status: "DRAFT",
      commission_rate: input.breakdown.commission_rate,
      commission_amount: input.breakdown.commission_amount,
      is_catering: input.is_catering ?? false,
      headcount: input.headcount ?? null,
      pickup_otp: null,
      qr_token: null,
      checked_in: false,
      scheduled_pickup_time: input.scheduled_pickup_time ?? null,
      created_at: now,
      updated_at: now,
    };
    this.orders.set(order.id, order);
    return order;
  }

  async getById(orderId: string): Promise<OrderDTO | null> {
    return this.orders.get(orderId) ?? null;
  }

  async getLatestByUser(userId: string): Promise<OrderDTO | null> {
    const userOrders = Array.from(this.orders.values())
      .filter((o) => o.user_id === userId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    return userOrders[0] ?? null;
  }

  async getByUser(userId: string): Promise<OrderDTO[]> {
    return Array.from(this.orders.values())
      .filter((o) => o.user_id === userId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
  }

  async getByUserPaginated(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ orders: OrderDTO[]; total: number }> {
    const all = Array.from(this.orders.values())
      .filter((o) => o.user_id === userId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    const start = (page - 1) * limit;
    return {
      orders: all.slice(start, start + limit),
      total: all.length,
    };
  }

  async updateStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<OrderDTO | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: OrderDTO = {
      ...order,
      status,
      updated_at: new Date().toISOString(),
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  async getByRestaurant(restaurantId: string): Promise<OrderDTO[]> {
    return Array.from(this.orders.values())
      .filter((o) => o.restaurant_id === restaurantId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
  }

  async getSettlableOrdersByRestaurant(
    restaurantId: string,
    fromIso: string,
    toIso: string,
  ): Promise<OrderDTO[]> {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    return Array.from(this.orders.values())
      .filter((o) => o.restaurant_id === restaurantId)
      .filter((o) => o.status === "PICKED_UP" || o.status === "SETTLED")
      .filter((o) => {
        const t = Date.parse(o.created_at);
        return Number.isFinite(t) && t >= from && t < to;
      })
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
  }

  async setPickupOtp(
    orderId: string,
    otp: string,
    qrToken: string,
  ): Promise<OrderDTO | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: OrderDTO = {
      ...order,
      pickup_otp: otp,
      qr_token: qrToken,
      updated_at: new Date().toISOString(),
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  async setCheckedIn(orderId: string): Promise<OrderDTO | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: OrderDTO = {
      ...order,
      checked_in: true,
      updated_at: new Date().toISOString(),
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  async findByQrToken(qrToken: string): Promise<OrderDTO | null> {
    for (const o of this.orders.values()) {
      if (o.qr_token === qrToken) return o;
    }
    return null;
  }

  async setItems(
    orderId: string,
    items: Omit<OrderItemDTO, "id">[],
    breakdown: PriceBreakdown,
  ): Promise<OrderDTO | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: OrderDTO = {
      ...order,
      items: items.map((item) => ({
        ...item,
        id: randomUUID(),
      })),
      total_amount: breakdown.total_amount,
      commission_rate: breakdown.commission_rate,
      commission_amount: breakdown.commission_amount,
      updated_at: new Date().toISOString(),
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  /** Resets the store between tests. */
  _reset(): void {
    this.orders.clear();
  }

  /** Seeds a full order DTO directly (used by tests to backdate created_at). */
  _seed(order: OrderDTO): OrderDTO {
    this.orders.set(order.id, order);
    return order;
  }
}
