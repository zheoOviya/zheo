import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import { sharedGiftRepo, sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
import { GiftService } from "../services/gift";
import { PaymentService } from "../services/payments";

const CustomizationSchema = z.object({
  name: z.string().min(1).max(100),
  price_delta: z.number().default(0),
});

const CreateGiftSchema = z.object({
  restaurant_id: z.string().uuid(),
  menu_item_id: z.string().uuid(),
  customizations: z.array(CustomizationSchema).default([]),
  message: z.string().min(1).max(280).optional(),
  recipient_name: z.string().min(1).max(80).optional(),
});

const TokenParamSchema = z.object({
  token: z.string().min(1).max(128),
});

const GiftIdParamSchema = z.object({
  id: z.string().uuid(),
});

const giftService = new GiftService(sharedGiftRepo, sharedPaymentRepo, getCatalogRepository());
const paymentService = new PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo);

export const giftsRouter: Router = Router();

giftsRouter.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateGiftSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift request", 400, body.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.create({ sender_id: userId, ...body.data });
    const payment = await paymentService.createGiftPayment(gift.id);
    ok(res, { gift, ...payment }, 201);
  }),
);

giftsRouter.post(
  "/:id/pay",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = GiftIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift id", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = (await giftService.getMine(userId)).find((g) => g.id === params.data.id);
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    if (gift.status !== "PENDING") {
      throw new AppError("GIFT_NOT_PAYABLE", `Gift is ${gift.status}, not payable`, 400);
    }
    const payment = await paymentService.createGiftPayment(gift.id);
    ok(res, { gift, ...payment });
  }),
);

giftsRouter.post(
  "/:id/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = GiftIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift id", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const updated = await giftService.cancel(params.data.id, userId);
    ok(res, updated);
  }),
);

giftsRouter.get(
  "/mine",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    const gifts = await giftService.getMine(userId);
    ok(res, gifts);
  }),
);

giftsRouter.get(
  "/t/:token",
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const viewerId = (res.locals.userId as string | undefined) ?? null;
    const landing = await giftService.getLanding(params.data.token, viewerId);
    ok(res, landing);
  }),
);

giftsRouter.post(
  "/t/:token/claim",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.claim(params.data.token, userId);
    ok(res, gift);
  }),
);

giftsRouter.post(
  "/t/:token/release",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.release(params.data.token, userId);
    ok(res, gift);
  }),
);
