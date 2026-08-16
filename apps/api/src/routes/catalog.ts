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
// lat/lng are the P04 traffic-ETA pickup origins (Mumbai, IN).
const SEED_RESTAURANTS: RestaurantDTO[] = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Biryani House",
    gst_number: "27AABCB1234A1Z5",
    owner_id: "e0000000-0000-4000-a000-000000000001",
    commission_rate: 0.08,
    is_active: true,
    lat: 19.076,
    lng: 72.8777,
    pickup_eta_min: 25,
    rating: 4.5,
    cuisines: ["North Indian", "Biryani"],
    price_for_one: 300,
    cover_image: "https://picsum.photos/seed/biryani-house/600/450",
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Green Bowl",
    gst_number: "27AACCG5678B1Z3",
    owner_id: "e0000000-0000-4000-a000-000000000002",
    commission_rate: 0.08,
    is_active: true,
    lat: 19.1136,
    lng: 72.8697,
    pickup_eta_min: 15,
    rating: 4.2,
    cuisines: ["Healthy", "Salads"],
    price_for_one: 250,
    cover_image: "https://picsum.photos/seed/green-bowl/600/450",
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    name: "Closed Kitchen",
    gst_number: "27AADDH9012C1Z7",
    owner_id: "e0000000-0000-4000-a000-000000000003",
    commission_rate: 0.05,
    is_active: false,
    lat: 18.9647,
    lng: 72.8258,
    pickup_eta_min: 30,
    rating: 3.9,
    cuisines: ["Continental"],
    price_for_one: 200,
    cover_image: "https://picsum.photos/seed/closed-kitchen/600/450",
  },
];

const SEED_MENU: MenuItemDTO[] = [
  {
    id: "b0000000-0000-4000-8000-000000000001",
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    price: 220,
    description: "Hyderabadi-style chicken biryani with saffron rice.",
    dietary_tags: { NON_VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/chicken-biryani/400/300",
    pos_item_id: null,
    spice_level: 5,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000002",
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    name: "Veg Biryani",
    price: 180,
    description: "Seasonal vegetables slow-cooked with basmati rice.",
    dietary_tags: { VEG: true, JAIN: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/veg-biryani/400/300",
    pos_item_id: null,
    spice_level: 2,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000003",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Paneer Wrap",
    price: 160,
    description: "Paneer tikka wrapped in a warm whole-wheat roti.",
    dietary_tags: { VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/paneer-wrap/400/300",
    pos_item_id: null,
    spice_level: 1,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000004",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Chicken Shawarma",
    price: 190,
    description: "Chicken shawarma with garlic sauce.",
    dietary_tags: { NON_VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/chicken-shawarma/400/300",
    pos_item_id: null,
    spice_level: 3,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000005",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Unavailable Dish",
    price: 99,
    description: null,
    dietary_tags: { VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/unavailable-dish/400/300",
    pos_item_id: null,
    spice_level: 1,
    is_available: false,
  },
];

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
