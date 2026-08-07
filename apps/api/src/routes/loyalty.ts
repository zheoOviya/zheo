import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getLoyaltyService } from "../services/loyalty";
import { getRetentionService } from "../services/retention";
import { etaService } from "../services/etaService";

// ============================================
// Loyalty context routes - /api/v1/loyalty
// L05 Refer & Earn, L01 Stamp Cards
// P04 Traffic ETA (mounted at /api/v1/eta)
// Auth: user_id extracted from verified JWT.
// ============================================

const ApplyReferralSchema = z.object({
  referral_code: z
    .string()
    .min(1, "referral_code is required")
    .max(24, "referral_code too long"),
});

const EtaQuerySchema = z.object({
  origin_lat: z.coerce.number().min(-90).max(90),
  origin_lng: z.coerce.number().min(-180).max(180),
  destination_lat: z.coerce.number().min(-90).max(90),
  destination_lng: z.coerce.number().min(-180).max(180),
});

const loyaltyService = getLoyaltyService();

/** Client IP for fraud screening: x-forwarded-for (trust proxy) then req.ip. */
function clientIpOf(req: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
  return (req.ip ?? req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function deviceFingerprintOf(req: {
  headers: Record<string, unknown>;
}): string {
  const fp = req.headers["x-device-fingerprint"];
  return typeof fp === "string" ? fp : "";
}

export const loyaltyRouter: Router = Router();

const retentionService = getRetentionService();

loyaltyRouter.get(
  "/wallet",
  authenticate,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const wallet = await retentionService.getWallet(userId);
    ok(res, wallet);
  }),
);

loyaltyRouter.get(
  "/streak",
  authenticate,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const streak = await retentionService.getStreak(userId);
    ok(res, streak);
  }),
);

loyaltyRouter.get(
  "/referral",
  authenticate,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const profile = await loyaltyService.getReferralProfile(userId);
    ok(res, profile);
  }),
);

loyaltyRouter.post(
  "/apply-referral",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = ApplyReferralSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid referral request",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    const result = await loyaltyService.applyReferral({
      claimantUserId: userId,
      referralCode: body.data.referral_code,
      ipAddress: clientIpOf(req),
      deviceFingerprint: deviceFingerprintOf(req),
    });

    ok(res, result, 201);
  }),
);

loyaltyRouter.get(
  "/stamp-cards",
  authenticate,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const cards = await loyaltyService.getStampCards(userId);
    ok(res, cards);
  }),
);

loyaltyRouter.get(
  "/stamp-cards/:restaurantId",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    const restaurantId = req.params.restaurantId as string;
    if (!/^[0-9a-f-]{36}$/i.test(restaurantId)) {
      throw new AppError("VALIDATION_ERROR", "Invalid restaurant id", 400);
    }
    const card = await loyaltyService.getStampCard(userId, restaurantId);
    ok(res, card ?? {
      user_id: userId,
      restaurant_id: restaurantId,
      stamp_count: 0,
      total_orders: 0,
      rewards_earned: 0,
      reward_type: "FREE_ITEM",
    });
  }),
);

export const etaRouter: Router = Router();

// GET /api/v1/eta - traffic-based ETA between two coordinates.
etaRouter.get(
  "/eta",
  asyncHandler(async (req, res) => {
    const query = EtaQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "origin_lat, origin_lng, destination_lat, destination_lng are required",
        400,
        query.error.flatten(),
      );
    }
    const { origin_lat, origin_lng, destination_lat, destination_lng } =
      query.data;
    const eta = await etaService.getTrafficETA(
      origin_lat,
      origin_lng,
      destination_lat,
      destination_lng,
    );
    ok(res, eta);
  }),
);
