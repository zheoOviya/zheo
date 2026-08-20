import type { CatalogRepository } from "../repositories/catalogRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import {
  type CreateOrderInput,
  type OrderDTO,
  type OrderRepository,
} from "../repositories/orderRepository";
import {
  calculatePriceBreakdown,
  type CustomizationDelta,
} from "./pricing";

// ============================================
// W12 Catering Orders (ordering context, Phase 4)
// Bulk B2B orders (50+ headcount) with advance scheduling.
// Unlike the consumer flow this route:
//   - bypasses the standard per-line quantity cap (up to 1000),
//   - allows a negotiated unit_price override per line (custom bulk pricing),
//   - allows a line-level description (custom bulk description),
//   - flags the aggregate with is_catering = true + headcount,
//   - auto-confirms via a simulated separate catering-confirmation flow
//     (DRAFT -> CONFIRMED outside the consumer fulfillment state machine).
// ============================================

export const CATERING_MIN_HEADCOUNT = 50;
export const CATERING_MAX_LINE_QUANTITY = 1000;

export interface CateringLineInput {
  menu_item_id: string;
  quantity: number;
  /** Optional negotiated bulk unit price. Falls back to the catalog price. */
  unit_price?: number;
  description?: string;
}

export interface CateringOrderRequest {
  user_id: string;
  restaurant_id: string;
  event_date: string;
  headcount: number;
  budget?: number;
  special_instructions?: string;
  items: CateringLineInput[];
}

export class CateringService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  async placeCateringOrder(
    request: CateringOrderRequest,
  ): Promise<OrderDTO> {
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

    if (request.headcount < CATERING_MIN_HEADCOUNT) {
      throw new AppError(
        "CATERING_HEADCOUNT_TOO_SMALL",
        `Catering requires a minimum of ${CATERING_MIN_HEADCOUNT} guests`,
        400,
      );
    }

    if (request.items.length === 0) {
      throw new AppError("EMPTY_ORDER", "At least one item is required", 400);
    }

    const lines = [];
    for (const line of request.items) {
      if (line.quantity < 1) {
        throw new AppError(
          "INVALID_QUANTITY",
          `Quantity must be >= 1 for item ${line.menu_item_id}`,
          400,
        );
      }
      if (line.quantity > CATERING_MAX_LINE_QUANTITY) {
        throw new AppError(
          "QUANTITY_EXCEEDS_LIMIT",
          `Quantity ${line.quantity} exceeds the catering limit of ${CATERING_MAX_LINE_QUANTITY}`,
          400,
        );
      }

      const menuItem = await this.catalogRepo.getMenuItemById(
        line.menu_item_id,
      );
      if (!menuItem || !menuItem.is_available) {
        throw new AppError(
          "ITEM_NOT_FOUND",
          `Menu item ${line.menu_item_id} not found or unavailable`,
          404,
        );
      }
      if (menuItem.restaurant_id !== request.restaurant_id) {
        throw new AppError(
          "ITEM_RESTAURANT_MISMATCH",
          `Item ${line.menu_item_id} does not belong to restaurant ${request.restaurant_id}`,
          400,
        );
      }

      const unitPrice = line.unit_price ?? menuItem.price;
      lines.push({
        menu_item_id: line.menu_item_id,
        name: line.description
          ? `${menuItem.name} (${line.description})`
          : menuItem.name,
        base_price: unitPrice,
        quantity: line.quantity,
        customizations: [] as CustomizationDelta[],
      });
    }

    const breakdown = calculatePriceBreakdown(lines);

    const input: CreateOrderInput = {
      user_id: request.user_id,
      restaurant_id: request.restaurant_id,
      items: lines.map((line) => {
        const b = breakdown.items.find(
          (i) => i.menu_item_id === line.menu_item_id,
        );
        return {
          menu_item_id: line.menu_item_id,
          name: line.name,
          base_price: line.base_price,
          quantity: line.quantity,
          customizations: line.customizations,
          gift_id: null,
          customization_total: b?.customization_total ?? 0,
          item_subtotal: b?.item_subtotal ?? 0,
        };
      }),
      breakdown,
      scheduled_pickup_time: request.event_date,
      is_catering: true,
      headcount: request.headcount,
    };

    const order = await this.orderRepo.create(input);

    // Simulated separate catering-confirmation flow: the B2B desk approves
    // the quote, so the order moves DRAFT -> CONFIRMED outside the consumer
    // fulfillment state machine (which deliberately has no DRAFT transition).
    const confirmed = await this.orderRepo.updateStatus(order.id, "CONFIRMED");
    if (!confirmed) {
      throw new AppError(
        "CATERING_CONFIRM_FAILED",
        "Failed to confirm catering order",
        500,
      );
    }

    await emit(
      createEventEnvelope("CateringOrderCreated", order.id, {
        order_id: order.id,
        restaurant_id: order.restaurant_id,
        user_id: order.user_id,
        headcount: request.headcount,
        event_date: request.event_date,
        total_amount: confirmed.total_amount,
        line_count: request.items.length,
      }),
    );

    return confirmed;
  }
}
