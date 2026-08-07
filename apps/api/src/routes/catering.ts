import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import { sharedAuditRepo, sharedOrderRepo } from "../repositories/shared";
import {
  CateringService,
  CATERING_MAX_LINE_QUANTITY,
  CATERING_MIN_HEADCOUNT,
} from "../services/catering";

// ============================================
// W12 Catering Orders - POST /api/v1/orders/catering
// Ordering context. Bulk B2B requests (50+ headcount) with advance
// scheduling, custom bulk pricing (unit_price override) and line-level
// descriptions. Auth required.
// ============================================

const CateringLineSchema = z.object({
  menu_item_id: z.string().uuid("menu_item_id must be a valid uuid"),
  quantity: z.number().int().min(1).max(CATERING_MAX_LINE_QUANTITY),
  unit_price: z.number().positive("unit_price must be positive").max(100000).optional(),
  description: z.string().min(1).max(200).optional(),
});

const CateringOrderSchema = z.object({
  restaurant_id: z.string().uuid(),
  event_date: z
    .string()
    .datetime({ offset: true })
    .refine((d) => Date.parse(d) > Date.now(), {
      message: "event_date must be in the future (advance scheduling)",
    }),
  headcount: z.number().int().min(CATERING_MIN_HEADCOUNT),
  budget: z.number().positive("budget must be positive").max(10000000).optional(),
  special_instructions: z.string().min(1).max(2000).optional(),
  items: z.array(CateringLineSchema).min(1).max(50),
});

const cateringService = new CateringService(
  sharedOrderRepo,
  getCatalogRepository(),
);

export const cateringRouter: Router = Router();

cateringRouter.post(
  "/catering",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CateringOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid catering order request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const order = await cateringService.placeCateringOrder({
      user_id: userId,
      restaurant_id: body.data.restaurant_id,
      event_date: body.data.event_date,
      headcount: body.data.headcount,
      budget: body.data.budget,
      special_instructions: body.data.special_instructions,
      items: body.data.items,
    });

    await sharedAuditRepo.log(userId, "catering_order_created", {
      order_id: order.id,
      restaurant_id: order.restaurant_id,
      headcount: body.data.headcount,
      is_catering: order.is_catering,
      status: order.status,
    });

    ok(
      res,
      {
        id: order.id,
        restaurant_id: order.restaurant_id,
        status: order.status,
        is_catering: order.is_catering,
        headcount: order.headcount,
        total_amount: order.total_amount,
        items: order.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          base_price: i.base_price,
          item_subtotal: i.item_subtotal,
        })),
        event_date: order.scheduled_pickup_time,
        budget: body.data.budget ?? null,
        special_instructions: body.data.special_instructions ?? null,
      },
      201,
    );
  }),
);
