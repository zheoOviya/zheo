import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import {
  sharedGroupCartRepo,
  sharedIdentityRepo,
  sharedOrderRepo,
} from "../repositories/shared";
import { GroupOrderService } from "../services/groupOrder";

// ============================================
// Group Order routes (ordering context, O02) - /api/v1/orders/group
//   POST /group/create  (auth) mints a shareable group_cart_token + DRAFT order
//   POST /group/add     (auth) ANY authenticated user with the token adds items
//   GET  /group/cart    (public, share-key auth) live group cart snapshot
// Concurrency is handled inside GroupOrderService via a per-token mutex.
// ============================================

const CreateGroupCartSchema = z.object({
  restaurant_id: z.string().uuid(),
});

const CustomizationSchema = z.object({
  name: z.string().min(1),
  price_delta: z.number().default(0),
});

const GroupAddItemSchema = z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(50),
  customizations: z.array(CustomizationSchema).default([]),
});

const AddToGroupCartSchema = z.object({
  group_cart_token: z.string().min(1).max(128),
  items: z.array(GroupAddItemSchema).min(1, "At least one item is required"),
});

const CartQuerySchema = z.object({
  token: z.string().min(1).max(128),
});

const groupOrderService = new GroupOrderService(
  sharedOrderRepo,
  getCatalogRepository(),
  sharedGroupCartRepo,
  sharedIdentityRepo,
);

export const groupOrdersRouter: Router = Router();

groupOrdersRouter.post(
  "/group/create",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateGroupCartSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid group cart request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    const created = await groupOrderService.createGroupCart({
      user_id: userId,
      restaurant_id: body.data.restaurant_id,
    });

    const shareLink = `${req.protocol}://${req.get("host") ?? "localhost"}/group-cart?token=${created.group_cart_token}`;

    ok(res, { ...created, share_link: shareLink }, 201);
  }),
);

groupOrdersRouter.post(
  "/group/add",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = AddToGroupCartSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid group cart add request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    const result = await groupOrderService.addToGroupCart({
      token: body.data.group_cart_token,
      user_id: userId,
      items: body.data.items,
    });

    ok(res, result);
  }),
);

groupOrdersRouter.get(
  "/group/cart",
  asyncHandler(async (req, res) => {
    const query = CartQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "token query param is required",
        400,
        query.error.flatten(),
      );
    }
    const snapshot = await groupOrderService.getGroupCart(query.data.token);
    ok(res, snapshot);
  }),
);
