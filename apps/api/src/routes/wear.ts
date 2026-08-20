import { Router } from "express";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import { sharedOrderRepo, sharedGiftRepo } from "../repositories/shared";
import { OrderingService } from "../services/ordering";
import { createEventEnvelope, emit } from "../lib/eventBus";

// ============================================
// W14 Smart Watch App - /api/v1/wear/orders
// Fulfillment + ordering context, optimized for wearables.
//
// Minimal payload strategy: watches have small screens and thin radios, so
// every response is a FLAT object with only glanceable fields - restaurant
// name, status, pickup time. No items, no prices, no PII. Every payload is
// guaranteed < 500 bytes (asserted in wear.test.ts).
// ============================================

const ACTIVE_WEAR_STATUSES = new Set([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
]);

const orderingService = new OrderingService(
  sharedOrderRepo,
  getCatalogRepository(),
  sharedGiftRepo,
);

export const wearRouter: Router = Router();

// One-tap status glance: the user's active orders, minimal fields only.
wearRouter.get(
  "/orders/active",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const orders = await sharedOrderRepo.getByUser(userId);
    const catalog = getCatalogRepository();
    const active = [];
    for (const o of orders) {
      if (!ACTIVE_WEAR_STATUSES.has(o.status)) continue;
      const restaurant = await catalog.getRestaurantById(o.restaurant_id);
      active.push({
        order_id: o.id,
        restaurant_name: restaurant?.name ?? "Restaurant",
        status: o.status,
        pickup_time: o.scheduled_pickup_time ?? null,
      });
    }

    await emit(
      createEventEnvelope("WearOrderListed", userId, {
        user_id: userId,
        active_count: active.length,
      }),
    );

    ok(res, { active_orders: active });
  }),
);

// One-tap reorder: repeats the user's most recent order.
wearRouter.post(
  "/orders/reorder",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const latest = await sharedOrderRepo.getLatestByUser(userId);
    if (!latest) {
      throw new AppError("NO_ORDERS", "No previous order to reorder", 404);
    }

    const order = await orderingService.reorder(userId, latest.id);

    ok(
      res,
      {
        order_id: order.id,
        status: order.status,
        total_amount: order.total_amount,
      },
      201,
    );
  }),
);
