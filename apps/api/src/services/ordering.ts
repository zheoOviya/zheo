import { randomUUID } from "node:crypto";
import type { CatalogRepository } from "../repositories/catalogRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import {
  type OrderRepository,
  type CreateOrderInput,
  type OrderDTO,
} from "../repositories/orderRepository";
import {
  calculatePriceBreakdown,
  type CustomizationDelta,
  type OrderItemInput,
} from "./pricing";

// ============================================
// Ordering context service (ordering bounded context)
// Orchestrates: validation -> pricing -> persistence -> event emission.
// ============================================

export interface PlaceOrderRequest {
  user_id: string;
  restaurant_id: string;
  items: {
    menu_item_id: string;
    quantity: number;
    customizations: CustomizationDelta[];
  }[];
  scheduled_pickup_time?: string;
}

export class OrderingService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  async placeOrder(request: PlaceOrderRequest): Promise<OrderDTO> {
    const restaurant = await this.catalogRepo.getRestaurantById(
      request.restaurant_id,
    );
    if (!restaurant || !restaurant.is_active) {
      throw new AppError(
        "RESTAURANT_NOT_FOUND",
        "Restaurant not found or inactive",
        404,
      );
    }

    if (request.items.length === 0) {
      throw new AppError("EMPTY_ORDER", "At least one item is required", 400);
    }

    const orderItems: OrderItemInput[] = [];

    for (const item of request.items) {
      if (item.quantity < 1) {
        throw new AppError(
          "INVALID_QUANTITY",
          `Quantity must be >= 1 for item ${item.menu_item_id}`,
          400,
        );
      }

      const menuItem = await this.catalogRepo.getMenuItemById(
        item.menu_item_id,
      );
      if (!menuItem || !menuItem.is_available) {
        throw new AppError(
          "ITEM_NOT_FOUND",
          `Menu item ${item.menu_item_id} not found or unavailable`,
          404,
        );
      }

      if (menuItem.restaurant_id !== request.restaurant_id) {
        throw new AppError(
          "ITEM_RESTAURANT_MISMATCH",
          `Item ${item.menu_item_id} does not belong to restaurant ${request.restaurant_id}`,
          400,
        );
      }

      orderItems.push({
        menu_item_id: item.menu_item_id,
        name: menuItem.name,
        base_price: menuItem.price,
        quantity: item.quantity,
        customizations: item.customizations,
      });
    }

    const breakdown = calculatePriceBreakdown(orderItems);

    const input: CreateOrderInput = {
      user_id: request.user_id,
      restaurant_id: request.restaurant_id,
      items: orderItems.map((oi) => ({
        menu_item_id: oi.menu_item_id,
        name: oi.name,
        base_price: oi.base_price,
        quantity: oi.quantity,
        customizations: oi.customizations,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.item_subtotal ?? 0,
      })),
      breakdown,
      scheduled_pickup_time: request.scheduled_pickup_time,
    };

    const order = await this.orderRepo.create(input);

    await emit(
      createEventEnvelope("OrderCreated", order.id, { order }, {
        correlation_id: randomUUID(),
      }),
    );

    return order;
  }

  async reorder(userId: string, oldOrderId: string): Promise<OrderDTO> {
    const oldOrder = await this.orderRepo.getById(oldOrderId);
    if (!oldOrder) {
      throw new AppError("ORDER_NOT_FOUND", "Original order not found", 404);
    }

    const items = oldOrder.items.map((item) => ({
      menu_item_id: item.menu_item_id,
      quantity: item.quantity,
      customizations: item.customizations,
    }));

    return this.placeOrder({
      user_id: userId,
      restaurant_id: oldOrder.restaurant_id,
      items,
      scheduled_pickup_time: oldOrder.scheduled_pickup_time ?? undefined,
    });
  }
}
