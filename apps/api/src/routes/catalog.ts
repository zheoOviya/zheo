import { Router } from "express";
import { z } from "zod";
import { RestaurantSchema, MenuItemSchema } from "@snakzap/types";
import { config } from "../config";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import {
  ALLOWED_DIETARY_TAGS,
  type CatalogRepository,
  DrizzleCatalogRepository,
  MemoryCatalogRepository,
  type MenuItemDTO,
  type RestaurantDTO,
  type SearchResultDTO,
} from "../repositories/catalogRepository";
import { cacheKey, getOrSet } from "../services/cache";
import { jwtService } from "../services/jwt";
import { getStorageMode, sharedIdentityRepo } from "../repositories/shared";
import { getDb } from "../lib/db";
import { logger } from "../lib/logger";
import { SEED_MENU, SEED_RESTAURANTS } from "../seed/catalogData";

// ============================================
// Catalog context routes (discovery) - /api/v1
// D05 dietary filters, D08 search autocomplete
// ============================================

const RestaurantsQuerySchema = z.object({});
const MenuParamsSchema = z.object({
  id: z.string().uuid("Invalid restaurant id"),
});
const SearchQuerySchema = z.object({
  q: z.string().min(1, "q is required").max(100),
});
const FilterQuerySchema = z.object({
  dietary: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((t) => t.trim().toUpperCase()))
    .pipe(z.array(z.enum(ALLOWED_DIETARY_TAGS)).min(1)),
});

/**
 * D03 effective spice tolerance (1-5): explicit `spice_tolerance` query
 * param wins, otherwise the authenticated user's profile, otherwise none
 * (no filtering). A valid Bearer token whose user is unknown is ignored.
 */
async function effectiveSpiceToleranceOf(req: {
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): Promise<number | undefined> {
  const raw = req.query.spice_tolerance;
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = z.coerce.number().int().min(1).max(5).safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return undefined;
  }
  try {
    const sub = jwtService.verifyAccessToken(header.slice(7)).sub;
    const user = await sharedIdentityRepo.getById(sub);
    return user?.spice_tolerance;
  } catch {
    return undefined;
  }
}

// Public catalog shapes live in @snakzap/types (single source of truth).
const RestaurantResponseSchema = RestaurantSchema;
const MenuItemResponseSchema = MenuItemSchema;
const SearchResultResponseSchema = z.object({
  type: z.enum(["restaurant", "dish"]),
  id: z.string().uuid(),
  name: z.string(),
  restaurant_id: z.string().uuid().optional(),
});

const RestaurantsResponseSchema = z.array(RestaurantResponseSchema);
const MenuResponseSchema = z.array(MenuItemResponseSchema);
const SearchResponseSchema = z.array(SearchResultResponseSchema);
const FilterResponseSchema = z.array(MenuItemResponseSchema);

// Seeded fixture data for the offline/memory repository.
// Defined once in ../seed/catalogData (shared with the Postgres seed) so the
// memory catalog and the Drizzle-backed catalog stay in sync.

// Factory - storage-mode aware. In Postgres mode this returns the
// Drizzle-backed repository; otherwise it falls back to the shared in-memory
// repo (seeded from SEED_RESTAURANTS/SEED_MENU) so vendor menu updates stay
// immediately visible to the consumer catalog without a database.
let sharedCatalogRepo: CatalogRepository | null = null;

export function getCatalogRepository(): CatalogRepository {
  if (!sharedCatalogRepo) {
    sharedCatalogRepo =
      getStorageMode() === "postgres"
        ? new DrizzleCatalogRepository(getDb())
        : new MemoryCatalogRepository(SEED_RESTAURANTS, SEED_MENU);
  }
  return sharedCatalogRepo;
}

/** Test helper: re-seeds the shared in-memory catalog. */
export function resetCatalogRepository(): void {
  if (sharedCatalogRepo instanceof MemoryCatalogRepository) {
    sharedCatalogRepo._reset();
  }
}

export const catalogRouter: Router = Router();

catalogRouter.get(
  "/restaurants",
  asyncHandler(async (_req, res) => {
    const repo = getCatalogRepository();
    const data = await getOrSet<RestaurantDTO[]>(
      cacheKey("catalog", "restaurants"),
      config.catalog.cacheTtlRestaurants,
      () => repo.getActiveRestaurants(),
    );
    RestaurantsResponseSchema.parse(data);
    ok(res, data);
  }),
);

catalogRouter.get(
  "/restaurants/:id/menu",
  asyncHandler(async (req, res) => {
    const params = MenuParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid restaurant id", 400, params.error.flatten());
    }
    const repo = getCatalogRepository();
    const data = await getOrSet<MenuItemDTO[]>(
      cacheKey("catalog", "menu", params.data.id),
      config.catalog.cacheTtlMenu,
      () => repo.getMenu(params.data.id),
    );

    // D03: filter out items that exceed the user's spice tolerance.
    const tolerance = await effectiveSpiceToleranceOf(req);
    const filtered = tolerance ? data.filter((m) => m.spice_level <= tolerance) : data;

    MenuResponseSchema.parse(filtered);
    logger.info({
      message: "menu_fetched",
      restaurant_id: params.data.id,
      spice_tolerance: tolerance ?? null,
      filtered: filtered.length,
      correlation_id: res.locals.correlationId,
    });
    ok(res, filtered);
  }),
);

const PickupSlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

function generatePickupSlots(forDate: string) {
  const slots: Array<{
    time: string;
    label: string;
    available: boolean;
    current_orders: number;
    max_capacity: number;
  }> = [];
  const today = new Date().toISOString().slice(0, 10);
  const startHour = forDate === today ? Math.max(new Date().getHours() + 1, 8) : 8;
  const endHour = 23;

  for (let hour = startHour; hour < endHour; hour++) {
    for (const minute of [0, 15, 30, 45]) {
      const t = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const currentOrders = Math.floor(Math.random() * 6);
      slots.push({
        time: t,
        label: t,
        available: currentOrders < 10,
        current_orders: currentOrders,
        max_capacity: 10,
      });
    }
  }
  return slots;
}

catalogRouter.get(
  "/restaurants/:id/pickup-slots",
  asyncHandler(async (req, res) => {
    const params = MenuParamsSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid restaurant id", 400, params.error.flatten());
    }
    const query = PickupSlotsQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid date", 400, query.error.flatten());
    }

    const repo = getCatalogRepository();
    const restaurant = await repo.getRestaurantById(params.data.id);
    if (!restaurant || !restaurant.is_active) {
      throw new AppError("RESTAURANT_NOT_FOUND", "Restaurant not found or inactive", 404);
    }

    const slots = generatePickupSlots(query.data.date);
    ok(res, { restaurant_id: params.data.id, date: query.data.date, slots });
  }),
);

catalogRouter.get(
  "/search/autocomplete",
  asyncHandler(async (req, res) => {
    const query = SearchQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError("VALIDATION_ERROR", "q is required", 400, query.error.flatten());
    }
    const q = query.data.q.trim().toLowerCase();
    const repo = getCatalogRepository();
    const data = await getOrSet<SearchResultDTO[]>(
      cacheKey("catalog", "search", q),
      config.catalog.cacheTtlSearch,
      () => repo.autocomplete(q),
    );
    SearchResponseSchema.parse(data);
    ok(res, data);
  }),
);

catalogRouter.get(
  "/menu-items/filter",
  asyncHandler(async (req, res) => {
    const query = FilterQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid dietary tags", 400, query.error.flatten());
    }
    const tags = query.data.dietary;
    const repo = getCatalogRepository();
    const data = await getOrSet<MenuItemDTO[]>(
      cacheKey("catalog", "filter", tags.join(",")),
      config.catalog.cacheTtlFilter,
      () => repo.filterByDietary(tags),
    );
    FilterResponseSchema.parse(data);
    logger.info({
      message: "dietary_filtered",
      tags,
      results: data.length,
      correlation_id: res.locals.correlationId,
    });
    ok(res, data);
  }),
);
