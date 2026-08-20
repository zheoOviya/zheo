import { randomUUID } from "node:crypto";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GiftRepository } from "../repositories/giftRepository";
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
    gift_id?: string;
  }[];
  scheduled_pickup_time?: string;
}

export class OrderingService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
    private readonly giftRepo?: GiftRepository,
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

      let basePrice = menuItem.price;
      let customizations = item.customizations;
      let giftId: string | null = null;

      if (item.gift_id) {
        if (!this.giftRepo) {
          throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
        }
        const gift = await this.giftRepo.getById(item.gift_id);
        if (!gift) {
          throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
        }
        if (gift.status !== "CLAIMED" || gift.claimed_by !== request.user_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} is not claimed by this user`,
            400,
          );
        }
        if (gift.restaurant_id !== request.restaurant_id || gift.menu_item_id !== item.menu_item_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} does not match the requested item or restaurant`,
            400,
          );
        }
        if (Date.parse(gift.expires_at) <= Date.now()) {
          throw new AppError("GIFT_EXPIRED", "This gift has expired", 400);
        }
        basePrice = 0;
        // The sender already paid for the customizations in gift.price_paid;
        // keep the names for display but zero the deltas so the recipient
        // pays nothing.
        customizations = gift.item_snapshot.customizations.map((c) => ({
          name: c.name,
          price_delta: 0,
        }));
        giftId = gift.id;
      }

      orderItems.push({
        menu_item_id: item.menu_item_id,
        name: menuItem.name,
        base_price: basePrice,
        // A claimed gift redeems exactly one unit server-side.
        quantity: item.gift_id ? 1 : item.quantity,
        customizations,
        gift_id: giftId,
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
        gift_id: oi.gift_id ?? null,
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
      gift_id: undefined,
    }));

    return this.placeOrder({
      user_id: userId,
      restaurant_id: oldOrder.restaurant_id,
      items,
      scheduled_pickup_time: oldOrder.scheduled_pickup_time ?? undefined,
    });
  }
}
