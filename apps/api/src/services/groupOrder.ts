import { randomBytes } from "node:crypto";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GroupCartRepository } from "../repositories/groupCartRepository";
import type { IdentityRepository } from "../repositories/identityRepository";
import type {
  OrderDTO,
  OrderItemDTO,
  OrderRepository,
} from "../repositories/orderRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import {
  calculatePriceBreakdown,
  type CustomizationDelta,
  type OrderItemInput,
} from "./pricing";
import { logger } from "../lib/logger";

// ============================================
// Group Order service (ordering bounded context, O02)
//
// Concurrency contract: EVERY mutation of a group cart runs inside a
// per-token async mutex (Map<token, Promise>). Two contributors adding at
// the exact same millisecond queue on the token and serialize their
// read-modify-write, so both items persist - no lost updates. With Postgres
// this seam becomes `SELECT ... FOR UPDATE` on the cart row.
// ============================================

export interface CreateGroupCartRequest {
  user_id: string;
  restaurant_id: string;
}

export interface GroupCartAddItem {
  menu_item_id: string;
  quantity: number;
  customizations: CustomizationDelta[];
}

export interface AddToGroupCartRequest {
  token: string;
  user_id: string;
  items: GroupCartAddItem[];
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-4);
  return `••••${tail}`;
}

export function avatarSeedOf(phone: string): string {
  return phone.replace(/\D/g, "").slice(-4);
}

export class GroupOrderService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
    private readonly cartRepo: GroupCartRepository,
    private readonly identityRepo: IdentityRepository,
  ) {}

  /** Serializes all mutations for a given cart token. */
  private async withLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(token) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.locks.set(token, next.catch(() => undefined));
    return next;
  }

  async createGroupCart(request: CreateGroupCartRequest) {
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

    const emptyBreakdown = calculatePriceBreakdown([]);
    const order = await this.orderRepo.create({
      user_id: request.user_id,
      restaurant_id: request.restaurant_id,
      items: [],
      breakdown: emptyBreakdown,
    });

    const token = `gc_${randomBytes(12).toString("hex")}`;
    const cart = await this.cartRepo.create({
      token,
      order_id: order.id,
      restaurant_id: request.restaurant_id,
      created_by: request.user_id,
    });

    await emit(
      createEventEnvelope("GroupOrderCreated", order.id, {
        order_id: order.id,
        group_cart_token: token,
        created_by: request.user_id,
        restaurant_id: request.restaurant_id,
      }),
    );

    logger.info({
      message: "group_order_created",
      order_id: order.id,
      group_cart_token: token,
      created_by: request.user_id,
    });

    return {
      group_cart_token: token,
      order_id: order.id,
      restaurant_id: request.restaurant_id,
      created_at: cart.created_at,
    };
  }

  async addToGroupCart(request: AddToGroupCartRequest) {
    return this.withLock(request.token, async () => {
      const cart = await this.cartRepo.getByToken(request.token);
      if (!cart) {
        throw new AppError(
          "GROUP_CART_NOT_FOUND",
          "Unknown group cart token",
          404,
        );
      }

      const order = await this.orderRepo.getById(cart.order_id);
      if (!order) {
        throw new AppError("ORDER_NOT_FOUND", "Group order not found", 404);
      }
      if (order.status !== "DRAFT") {
        throw new AppError(
          "GROUP_ORDER_LOCKED",
          "This group order has already been placed",
          409,
        );
      }

      // Validate every incoming item against OUR catalog (price is always
      // taken from the catalog, never the client).
      const validated: OrderItemInput[] = [];
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
        if (menuItem.restaurant_id !== cart.restaurant_id) {
          throw new AppError(
            "ITEM_RESTAURANT_MISMATCH",
            `Item ${item.menu_item_id} does not belong to this group order`,
            400,
          );
        }
        validated.push({
          menu_item_id: item.menu_item_id,
          name: menuItem.name,
          base_price: menuItem.price,
          quantity: item.quantity,
          customizations: item.customizations,
        });
      }

      // Merge existing order lines with the new items (single DRAFT order).
      const mergedInputs: OrderItemInput[] = [
        ...order.items.map((oi) => ({
          menu_item_id: oi.menu_item_id,
          name: oi.name,
          base_price: oi.base_price,
          quantity: oi.quantity,
          customizations: oi.customizations,
        })),
        ...validated,
      ];

      const breakdown = calculatePriceBreakdown(mergedInputs);

      const dtoItems: Omit<OrderItemDTO, "id">[] = mergedInputs.map((oi) => ({
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
      }));

      const updatedOrder = await this.orderRepo.setItems(
        cart.order_id,
        dtoItems,
        breakdown,
      );
      if (!updatedOrder) {
        throw new AppError("ORDER_NOT_FOUND", "Group order not found", 404);
      }

      // Resolve the contributor's masked identity for the live cart view.
      const identity = await this.identityRepo.getById(request.user_id);
      const displayName = identity ? maskPhone(identity.phone) : "Guest";
      const avatarSeed = identity ? avatarSeedOf(identity.phone) : "0000";

      await this.cartRepo.addContribution(request.token, {
        user_id: request.user_id,
        display_name: displayName,
        avatar_seed: avatarSeed,
        items: validated.map((v) => ({
          menu_item_id: v.menu_item_id,
          name: v.name,
          quantity: v.quantity,
          price: v.base_price,
        })),
      });

      for (const item of validated) {
        await emit(
          createEventEnvelope("GroupOrderItemAdded", updatedOrder.id, {
            order_id: updatedOrder.id,
            group_cart_token: request.token,
            added_by: request.user_id,
            menu_item_id: item.menu_item_id,
            quantity: item.quantity,
          }),
        );
      }

      logger.info({
        message: "group_order_item_added",
        order_id: updatedOrder.id,
        group_cart_token: request.token,
        added_by: request.user_id,
        item_count: validated.length,
      });

      const finalCart = await this.cartRepo.getByToken(request.token);
      const itemCount = updatedOrder.items.reduce(
        (sum, i) => sum + i.quantity,
        0,
      );

      return {
        order: updatedOrder,
        cart: {
          group_cart_token: request.token,
          item_count: itemCount,
          total_amount: updatedOrder.total_amount,
          contributors: finalCart?.contributors ?? [],
        },
      };
    });
  }

  /** Public snapshot for the live group cart view (share-key auth = token). */
  async getGroupCart(token: string) {
    const cart = await this.cartRepo.getByToken(token);
    if (!cart) {
      throw new AppError(
        "GROUP_CART_NOT_FOUND",
        "Unknown group cart token",
        404,
      );
    }
    const order = await this.orderRepo.getById(cart.order_id);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Group order not found", 404);
    }
    const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
    return {
      group_cart_token: token,
      restaurant_id: cart.restaurant_id,
      order_id: order.id,
      status: order.status,
      item_count: itemCount,
      total_amount: order.total_amount,
      items: order.items,
      contributors: cart.contributors,
      updated_at: cart.updated_at,
    };
  }
}
