import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import {
  sharedOrderRepo,
  sharedGiftRepo,
  sharedCheckoutIdempotencyRepo,
} from "../repositories/shared";
import {
  IDEMPOTENCY_KEY_HEADER,
  OrderingService,
  normalizeIdempotencyKey,
} from "../services/ordering";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// Consumer order response projection
// (CONSUMER-COMMISSION-EXPOSURE-A2).
//
// commission_rate / commission_amount are internal settlement economics
// (see services/pricing.ts) and must never reach a consumer response. They
// remain on the domain OrderDTO for vendor/admin/settlement use; the consumer
// route strips them at the boundary without mutating the source object.
// ============================================
export type ConsumerOrderDTO = Omit<
  OrderDTO,
  "commission_rate" | "commission_amount"
>;

export function toConsumerOrder(order: OrderDTO): ConsumerOrderDTO {
  const safe = { ...order };
  delete (safe as Partial<OrderDTO>).commission_rate;
  delete (safe as Partial<OrderDTO>).commission_amount;
  return safe as ConsumerOrderDTO;
}

// ============================================
// Ordering context routes - /api/v1/orders
// O06 customizations, O08 quick reorder, O10 price breakdown
// Auth: user_id extracted from verified JWT (auth middleware).
// ============================================

const CustomizationSchema = z.object({
  name: z.string().min(1),
  price_delta: z.number().default(0),
});

const OrderItemSchema = z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(50),
  customizations: z.array(CustomizationSchema).default([]),
  gift_id: z.string().uuid().optional(),
});

const CreateOrderSchema = z.object({
  restaurant_id: z.string().uuid(),
  items: z.array(OrderItemSchema).min(1),
  scheduled_pickup_time: z
    .string()
    .datetime({ offset: true })
    .optional(),
});

const ReorderSchema = z.object({
  old_order_id: z.string().uuid(),
});

const orderingService = new OrderingService(
  sharedOrderRepo,
  getCatalogRepository(),
  sharedGiftRepo,
  undefined,
  sharedCheckoutIdempotencyRepo,
);

export const ordersRouter: Router = Router();

const ListOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

ordersRouter.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const query = ListOrdersQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid query params", 400, query.error.flatten());
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const { limit, cursor } = query.data;

    const catalogRepo = getCatalogRepository();
    const allOrders = await sharedOrderRepo.getByUser(userId);

    const startIndex = cursor
      ? allOrders.findIndex((o) => o.created_at < cursor)
      : 0;

    if (startIndex === -1) {
      ok(res, { orders: [], next_cursor: null });
      return;
    }

    const page = allOrders.slice(startIndex, startIndex + limit);
    const lastOrder = page[page.length - 1];
    const nextCursor = page.length === limit && startIndex + limit < allOrders.length && lastOrder
      ? lastOrder.created_at
      : null;

    const enriched = await Promise.all(
      page.map(async (o) => {
        const restaurant = await catalogRepo.getRestaurantById(o.restaurant_id);
        return {
          id: o.id,
          user_id: o.user_id,
          restaurant_id: o.restaurant_id,
          restaurant_name: restaurant?.name ?? "Restaurant",
          status: o.status,
          total_amount: o.total_amount,
          items: o.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            base_price: i.base_price,
          })),
          created_at: o.created_at,
        };
      }),
    );

    ok(res, {
      orders: enriched,
      next_cursor: nextCursor,
    });
  }),
);

ordersRouter.get(
  "/:id",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : req.params.id?.[0] ?? "";
    const order = await sharedOrderRepo.getById(id);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    const userId = res.locals.userId as string;
    if (order.user_id !== userId) {
      throw new AppError("FORBIDDEN", "You do not have access to this order", 403);
    }

    ok(res, toConsumerOrder(order));
  }),
);

ordersRouter.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid order request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    // Consumer checkout only: an optional opaque Idempotency-Key makes the
    // create durable. Missing header preserves legacy behavior; a replayed key
    // returns the original order (HTTP 200) instead of creating a duplicate.
    const idempotencyKey = normalizeIdempotencyKey(
      req.header(IDEMPOTENCY_KEY_HEADER) ?? undefined,
    );

    const { order, replayed } = await orderingService.placeOrderIdempotent(
      {
        user_id: userId,
        restaurant_id: body.data.restaurant_id,
        items: body.data.items,
        scheduled_pickup_time: body.data.scheduled_pickup_time,
        scheduling_policy: "pickup-slot",
      },
      idempotencyKey,
    );

    ok(res, toConsumerOrder(order), replayed ? 200 : 201);
  }),
);

ordersRouter.post(
  "/reorder",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = ReorderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid reorder request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const order = await orderingService.reorder(userId, body.data.old_order_id);

    ok(res, toConsumerOrder(order), 201);
  }),
);

export { sharedOrderRepo as orderRepo };
