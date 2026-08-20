import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { requireConsumerOrAdmin } from "../middleware/requireRoles";
import { getCartPersistenceService } from "../services/cartPersistence";

// ============================================
// Ordering context routes - /api/v1/cart
// O09 Cart Persistence: the consumer cart is persisted server-side with
// a 24h inactivity TTL so a reload (or another device) never loses it.
// ============================================

const CartItemSchema = z.object({
  menu_item_id: z.string().uuid("Invalid menu item id"),
  quantity: z.number().int().min(1).max(99),
  name: z.string().optional(),
  base_price: z.number().optional(),
  customizations: z
    .array(z.object({ name: z.string(), price_delta: z.number() }))
    .optional(),
  restaurant_id: z.string().uuid().optional(),
  gift_id: z.string().uuid().optional(),
  gift_token: z.string().optional(),
});

const SaveCartSchema = z.object({
  items: z.array(CartItemSchema).max(50),
  restaurant_id: z.string().uuid().optional(),
  restaurant_name: z.string().optional(),
});

const cartPersistenceService = getCartPersistenceService();

export const cartRouter: Router = Router();

cartRouter.get(
  "/cart",
  requireConsumerOrAdmin,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const result = await cartPersistenceService.loadCart(userId);
    ok(res, result);
  }),
);

cartRouter.post(
  "/cart",
  requireConsumerOrAdmin,
  asyncHandler(async (req, res) => {
    const body = SaveCartSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid cart payload", 400, body.error.flatten());
    }
    const userId = res.locals.userId as string;
    await cartPersistenceService.saveCart(userId, body.data.items, {
      restaurant_id: body.data.restaurant_id ?? null,
      restaurant_name: body.data.restaurant_name ?? null,
    });
    ok(res, { saved: true, item_count: body.data.items.length });
  }),
);

cartRouter.delete(
  "/cart",
  requireConsumerOrAdmin,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    await cartPersistenceService.deleteCart(userId);
    ok(res, { cleared: true });
  }),
);
