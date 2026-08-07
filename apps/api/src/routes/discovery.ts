import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { jwtService } from "../services/jwt";
import { getCatalogRepository } from "./catalog";
import { sharedOrderRepo } from "../repositories/shared";
import {
  COLD_START_THRESHOLD,
  DEFAULT_CONSUMER_LOCATION,
  DEFAULT_HEATMAP_MINUTES,
  DiscoveryService,
} from "../services/discovery";

// ============================================
// Discovery context routes - /api/v1/discovery
// D07 Personalized Homepage, D17 Trending Now
//
// Personalized Homepage is OPTIONAL-auth: an authenticated Bearer token
// personalizes the feed (rule-based for < COLD_START_THRESHOLD orders,
// simulated-ML above it); anonymous callers get the cold-start experience.
// ============================================

const PersonalizedQuerySchema = z.object({});

const TrendingQuerySchema = z.object({
  radius_km: z.coerce.number().positive().max(50).optional(),
  minutes: z.coerce.number().int().positive().max(1440).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const discoveryService = new DiscoveryService(
  getCatalogRepository(),
  sharedOrderRepo,
);

/** Optional auth: personalizes the feed when a valid Bearer token is present. */
function optionalUserIdOf(req: {
  headers: Record<string, unknown>;
}): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  try {
    return jwtService.verifyAccessToken(header.slice(7)).sub;
  } catch {
    return undefined;
  }
}

export const discoveryRouter: Router = Router();

discoveryRouter.get(
  "/personalized-homepage",
  asyncHandler(async (req, res) => {
    PersonalizedQuerySchema.safeParse(req.query);
    const userId = optionalUserIdOf(req);
    const feed = await discoveryService.getPersonalizedHomepage(userId);
    ok(res, feed);
  }),
);

discoveryRouter.get(
  "/trending",
  asyncHandler(async (req, res) => {
    const query = TrendingQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid trending query",
        400,
        query.error.flatten(),
      );
    }
    const trending = await discoveryService.getTrending({
      radiusKm: query.data.radius_km,
      minutes: query.data.minutes,
      lat: query.data.lat,
      lng: query.data.lng,
    });
    ok(res, trending);
  }),
);

// D04 Hyperlocal Heatmap: real-time order density over the last 30 minutes.
// Public (no auth) - used by the admin ops dashboard. Lightweight cells only.
discoveryRouter.get(
  "/heatmap",
  asyncHandler(async (_req, res) => {
    const heatmap = await discoveryService.getHeatmap(DEFAULT_HEATMAP_MINUTES);
    ok(res, heatmap);
  }),
);

export { COLD_START_THRESHOLD, DEFAULT_CONSUMER_LOCATION };
