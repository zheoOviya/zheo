import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import { sharedOrderRepo } from "../repositories/shared";
import { OrderingService } from "../services/ordering";

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

const orderingService = new OrderingService(sharedOrderRepo, getCatalogRepository());

export const ordersRouter: Router = Router();

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

    ok(res, order);
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

    const order = await orderingService.placeOrder({
      user_id: userId,
      restaurant_id: body.data.restaurant_id,
      items: body.data.items,
      scheduled_pickup_time: body.data.scheduled_pickup_time,
    });

    ok(res, order, 201);
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

    ok(res, order, 201);
  }),
);

export { sharedOrderRepo as orderRepo };
