import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { orders, order_items } from "@snakzap/db";
import type { OrderStatus } from "@snakzap/types";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  OrderRepository,
  OrderDTO,
  OrderItemDTO,
  CreateOrderInput,
} from "../orderRepository";
import type { PriceBreakdown } from "../../services/pricing";

// ============================================
// Ordering context repository (Drizzle/Postgres)
// ============================================

function mapOrderRow(
  row: Record<string, unknown>,
  items: OrderItemDTO[],
): OrderDTO {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    restaurant_id: row.restaurant_id as string,
    items,
    total_amount: Number(row.total_amount),
    status: row.status as OrderStatus,
    commission_rate: Number(
      (row as Record<string, unknown>).commission_rate ?? 0.08,
    ),
    commission_amount: Number(
      (row as Record<string, unknown>).commission_amount ?? 0,
    ),
    is_catering: (row.is_catering as boolean) ?? false,
    headcount: (row.headcount as number | null) ?? null,
    pickup_otp: (row.pickup_otp as string) ?? null,
    qr_token: ((row as Record<string, unknown>).qr_token as string) ?? null,
    checked_in: ((row as Record<string, unknown>).checked_in as boolean) ?? false,
    scheduled_pickup_time:
      ((row as Record<string, unknown>).scheduled_pickup_time as string) ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapOrderItemRow(row: Record<string, unknown>): OrderItemDTO {
  return {
    id: row.id as string,
    menu_item_id: row.menu_item_id as string,
    name: row.name as string,
    base_price: Number(row.base_price),
    quantity: row.quantity as number,
    customizations: (row.customizations as OrderItemDTO["customizations"]) ?? [],
    customization_total: Number(row.customization_total),
    item_subtotal: Number(row.item_subtotal),
  };
}

export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly db: DrizzleDb) {}

  private async loadItems(orderId: string): Promise<OrderItemDTO[]> {
    const rows = (await this.db
      .select()
      .from(order_items)
      .where(eq(order_items.order_id, orderId))) as Record<string, unknown>[];
    return rows.map(mapOrderItemRow);
  }

  async create(input: CreateOrderInput): Promise<OrderDTO> {
    const orderId = randomUUID();
    const now = new Date();

    await this.db.insert(orders).values({
      id: orderId,
      user_id: input.user_id,
      restaurant_id: input.restaurant_id,
      total_amount: String(input.breakdown.total_amount),
      status: "DRAFT",
      is_catering: input.is_catering ?? false,
      headcount: input.headcount ?? null,
      pickup_otp: null,
      scheduled_pickup_time: input.scheduled_pickup_time
        ? new Date(input.scheduled_pickup_time)
        : null,
    });

    const items: OrderItemDTO[] = [];
    for (const item of input.items) {
      const itemId = randomUUID();
      await this.db.insert(order_items).values({
        id: itemId,
        order_id: orderId,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: String(item.base_price),
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: String(item.customization_total),
        item_subtotal: String(item.item_subtotal),
      });
      items.push({
        id: itemId,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: item.base_price,
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: item.customization_total,
        item_subtotal: item.item_subtotal,
      });
    }

    return {
      id: orderId,
      user_id: input.user_id,
      restaurant_id: input.restaurant_id,
      items,
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
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async getById(orderId: string): Promise<OrderDTO | null> {
    const rows = (await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const items = await this.loadItems(orderId);
    return mapOrderRow(row, items);
  }

  async getLatestByUser(userId: string): Promise<OrderDTO | null> {
    // DrizzleDb type doesn't expose orderBy/limit natively,
    // so we fetch user orders and pick the latest in-memory.
    const orders_ = await this.getByUser(userId);
    return orders_[0] ?? null;
  }

  async getByUser(userId: string): Promise<OrderDTO[]> {
    const rows = (await this.db
      .select()
      .from(orders)
      .where(eq(orders.user_id, userId))) as Record<string, unknown>[];
    const results: OrderDTO[] = [];
    for (const row of rows) {
      const items = await this.loadItems(row.id as string);
      results.push(mapOrderRow(row, items));
    }
    results.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return results;
  }

  async getByRestaurant(restaurantId: string): Promise<OrderDTO[]> {
    const rows = (await this.db
      .select()
      .from(orders)
      .where(eq(orders.restaurant_id, restaurantId))) as Record<string, unknown>[];
    const results: OrderDTO[] = [];
    for (const row of rows) {
      const items = await this.loadItems(row.id as string);
      results.push(mapOrderRow(row, items));
    }
    results.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return results;
  }

  async getSettlableOrdersByRestaurant(
    restaurantId: string,
    fromIso: string,
    toIso: string,
  ): Promise<OrderDTO[]> {
    const orders_ = await this.getByRestaurant(restaurantId);
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    return orders_
      .filter(
        (o) => o.status === "PICKED_UP" || o.status === "SETTLED",
      )
      .filter((o) => {
        const t = Date.parse(o.created_at);
        return Number.isFinite(t) && t >= from && t < to;
      })
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
  }

  async updateStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<OrderDTO | null> {
    await this.db
      .update(orders)
      .set({ status, updated_at: new Date() })
      .where(eq(orders.id, orderId));
    return this.getById(orderId);
  }

  async setPickupOtp(
    orderId: string,
    otp: string,
    qrToken: string,
  ): Promise<OrderDTO | null> {
    await this.db
      .update(orders)
      .set({ pickup_otp: otp, updated_at: new Date() })
      .where(eq(orders.id, orderId));
    return this.getById(orderId);
  }

  async setCheckedIn(orderId: string): Promise<OrderDTO | null> {
    // checked_in is not a DB column; update timestamp as a marker.
    await this.db
      .update(orders)
      .set({ updated_at: new Date() })
      .where(eq(orders.id, orderId));
    const dto = await this.getById(orderId);
    if (dto) dto.checked_in = true;
    return dto;
  }

  async findByQrToken(qrToken: string): Promise<OrderDTO | null> {
    // qr_token is not in the orders schema; scan all orders and match in-memory.
    // In production this would use a dedicated column.
    const allRows = (await (this.db as unknown as {
      select: () => { from: (t: unknown) => Promise<unknown[]> };
    })
      .select()
      .from(orders)) as Record<string, unknown>[];
    for (const row of allRows) {
      const dto = mapOrderRow(row, []);
      if (dto.pickup_otp === qrToken || dto.qr_token === qrToken) {
        return this.getById(row.id as string);
      }
    }
    return null;
  }

  async setItems(
    orderId: string,
    items: Omit<OrderItemDTO, "id">[],
    breakdown: PriceBreakdown,
  ): Promise<OrderDTO | null> {
    const existing = await this.getById(orderId);
    if (!existing) return null;

    // Delete existing items using raw access since DrizzleDb type doesn't expose delete
    await (this.db as unknown as {
      delete: (table: unknown) => { where: (cond: unknown) => Promise<unknown[]> };
    })
      .delete(order_items)
      .where(eq(order_items.order_id, orderId));

    const newItems: OrderItemDTO[] = [];
    for (const item of items) {
      const itemId = randomUUID();
      await this.db.insert(order_items).values({
        id: itemId,
        order_id: orderId,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: String(item.base_price),
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: String(item.customization_total),
        item_subtotal: String(item.item_subtotal),
      });
      newItems.push({ id: itemId, ...item });
    }

    await this.db
      .update(orders)
      .set({
        total_amount: String(breakdown.total_amount),
        updated_at: new Date(),
      })
      .where(eq(orders.id, orderId));

    return {
      ...existing,
      items: newItems,
      total_amount: breakdown.total_amount,
      commission_rate: breakdown.commission_rate,
      commission_amount: breakdown.commission_amount,
      updated_at: new Date().toISOString(),
    };
  }

  _seed(order: OrderDTO): OrderDTO {
    this.db.insert(orders).values({
      id: order.id,
      user_id: order.user_id,
      restaurant_id: order.restaurant_id,
      total_amount: String(order.total_amount),
      status: order.status,
      is_catering: order.is_catering ?? false,
      headcount: order.headcount ?? null,
      pickup_otp: order.pickup_otp,
      created_at: new Date(order.created_at),
      updated_at: new Date(order.updated_at),
    }).catch(() => {
      // Silently ignore duplicate seeds.
    });
    for (const item of order.items) {
      this.db.insert(order_items).values({
        id: item.id,
        order_id: order.id,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: String(item.base_price),
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: String(item.customization_total),
        item_subtotal: String(item.item_subtotal),
      }).catch(() => {});
    }
    return order;
  }

  async getAll(): Promise<OrderDTO[]> {
    const allRows = (await this.db
      .select()
      .from(orders)
      .where(undefined!)) as Record<string, unknown>[];
    const orderIds = allRows.map((r: Record<string, unknown>) => r.id as string);
    const itemsByOrder = new Map<string, OrderItemDTO[]>();
    for (const oid of orderIds) {
      const oiRows = (await this.db
        .select()
        .from(order_items)
        .where(eq(order_items.order_id, oid))) as Record<string, unknown>[];
      itemsByOrder.set(oid, oiRows.map(mapOrderItemRow));
    }
    return allRows.map((r: Record<string, unknown>) =>
      mapOrderRow(r, itemsByOrder.get(r.id as string) ?? []),
    );
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
