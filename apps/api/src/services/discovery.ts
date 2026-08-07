import type { CatalogRepository, RestaurantDTO } from "../repositories/catalogRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";

// ============================================
// Discovery context service (catalog bounded context)
// D07 Personalized Homepage + D17 Trending Now.
//
// Personalization strategy (PRD D07):
//   - Cold start (past orders < COLD_START_THRESHOLD): strict rule-based
//     ranking = time-of-day dietary boost + inferred dietary tags + location
//     proximity.
//   - Warm (>= threshold): simulated ML tier that multiplies the rule score by
//     past-restaurant frequency/recency affinity so habitual restaurants rise.
//   - Anti-filter-bubble: every feed MUST include exactly one "surprise"
//     restaurant that does NOT match the user's inferred preference, so the
//     homepage can never collapse into a single-preference bubble.
//
// Trending algorithm (PRD D17):
//   - Strictly time-bounded (last `minutes`, default 60) and radius-bounded
//     (default 5 km via haversine). Geo is mocked to the P04 consumer origin
//     when no coordinates are supplied (fully offline demo).
// ============================================

export const DEFAULT_CONSUMER_LOCATION = { lat: 18.9218, lng: 72.8308 };
export const COLD_START_THRESHOLD = 3;
export const DEFAULT_TRENDING_RADIUS_KM = 5;
export const DEFAULT_TRENDING_MINUTES = 60;
export const TRENDING_TOP_N = 5;
/** D04 hyperlocal heatmap window (PRD: last 30 minutes). */
export const DEFAULT_HEATMAP_MINUTES = 30;

export type TimeOfDay =
  | "breakfast"
  | "lunch"
  | "evening"
  | "late_night";

const DISALLOWED_TRENDING_STATUSES = new Set([
  "DRAFT",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "CANCELLED",
  "EXPIRED",
  "DISPUTED",
  "REFUNDED",
]);

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function timeOfDay(date: Date = new Date()): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 21) return "evening";
  return "late_night";
}

// Time-of-day dietary boost: breakfast/evening favour lighter VEG/JAIN menus,
// lunch/late-night favour NON_VEG. Deterministic, keeps the rule tier honest.
const TOD_DIETARY_BOOST: Record<
  TimeOfDay,
  Record<string, number>
> = {
  breakfast: { VEG: 1.08, JAIN: 1.08, NON_VEG: 0.95, HALAL: 0.98 },
  lunch: { VEG: 1.0, JAIN: 1.0, NON_VEG: 1.08, HALAL: 1.05 },
  evening: { VEG: 1.05, JAIN: 1.05, NON_VEG: 1.0, HALAL: 1.0 },
  late_night: { VEG: 0.95, JAIN: 0.95, NON_VEG: 1.05, HALAL: 1.05 },
};

export interface PersonalizedRestaurant {
  restaurant: RestaurantDTO;
  reason: string;
  score: number;
}

export interface PersonalizedHomepage {
  user_profile: {
    is_cold_start: boolean;
    past_order_count: number;
    inferred_dietary_tags: string[];
    strategy: "rule_based" | "ml_weighted";
  };
  personalized_restaurants: PersonalizedRestaurant[];
  surprise_restaurant: PersonalizedRestaurant | null;
}

export interface TrendingDish {
  menu_item_id: string;
  name: string;
  price: number;
  restaurant_id: string;
  restaurant_name: string;
  orders_count: number;
  quantity_sold: number;
}

export interface TrendingResponse {
  window_minutes: number;
  radius_km: number;
  location: { lat: number; lng: number };
  generated_at: string;
  trending: TrendingDish[];
}

export class DiscoveryService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly orderRepo: OrderRepository,
  ) {}

  // ==================== D07 Personalized Homepage ====================

  async getPersonalizedHomepage(userId?: string): Promise<PersonalizedHomepage> {
    const restaurants = await this.catalogRepo.getActiveRestaurants();
    const pastOrders = userId
      ? await this.orderRepo.getByUser(userId)
      : [];

    const isColdStart = pastOrders.length < COLD_START_THRESHOLD;
    const strategy = isColdStart ? "rule_based" : "ml_weighted";

    if (restaurants.length === 0) {
      return {
        user_profile: {
          is_cold_start: isColdStart,
          past_order_count: pastOrders.length,
          inferred_dietary_tags: [],
          strategy,
        },
        personalized_restaurants: [],
        surprise_restaurant: null,
      };
    }

    // Infer dietary tags from the user's ordered items (catalog lookup).
    const inferredTags = await this.inferDietaryTags(pastOrders);

    // Per-restaurant menu (used for dietary overlap and surprise selection).
    const menuByRestaurant = new Map<string, Awaited<ReturnType<CatalogRepository["getMenuAll"]>>>();
    for (const r of restaurants) {
      menuByRestaurant.set(r.id, await this.catalogRepo.getMenuAll(r.id));
    }

    const tod = timeOfDay();

    const scored = restaurants.map((restaurant) => {
      const menu = menuByRestaurant.get(restaurant.id) ?? [];
      const dietary = this.dietaryMatch(menu, inferredTags);
      const ruleScore = this.ruleScore(restaurant, menu, dietary, tod);
      const mlAffinity = strategy === "ml_weighted"
        ? this.pastRestaurantAffinity(restaurant.id, pastOrders)
        : 0;
      const score = ruleScore * (1 + 0.6 * mlAffinity);
      return {
        restaurant,
        menu,
        dietary,
        score,
        reason: this.pickReason(restaurant, mlAffinity, tod),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    // Reserve one slot for the surprise restaurant so it can never be a top
    // pick (anti-filter-bubble), even in a sparse catalog.
    const topCount = Math.min(4, scored.length - 1);
    const top = scored.slice(0, Math.max(0, topCount));

    const personalized_restaurants: PersonalizedRestaurant[] = top.map(
      ({ restaurant, score, reason }) => ({ restaurant, score, reason }),
    );

    // Anti-filter-bubble: pick the surprise from the LOWEST-affinity
    // restaurants (lowest dietary overlap), never from the top picks.
    const surprisePool = scored
      .filter((s) => !top.includes(s))
      .sort((a, b) => a.dietary - b.dietary);
    const surprise = surprisePool[0] ?? scored[scored.length - 1];

    if (!surprise) {
      return {
        user_profile: {
          is_cold_start: isColdStart,
          past_order_count: pastOrders.length,
          inferred_dietary_tags: inferredTags,
          strategy,
        },
        personalized_restaurants: [],
        surprise_restaurant: null,
      };
    }

    await emit(
      createEventEnvelope("PersonalizedHomepageViewed", userId ?? "anonymous", {
        user_id: userId,
        strategy,
        is_cold_start: isColdStart,
        result_count: personalized_restaurants.length,
      }),
    );

    logger.info({
      message: "personalized_homepage_viewed",
      user_id: userId,
      strategy,
      is_cold_start: isColdStart,
      results: personalized_restaurants.length,
    });

    return {
      user_profile: {
        is_cold_start: isColdStart,
        past_order_count: pastOrders.length,
        inferred_dietary_tags: inferredTags,
        strategy,
      },
      personalized_restaurants,
      surprise_restaurant: {
        restaurant: surprise.restaurant,
        score: surprise.score,
        reason: "Something new for you",
      },
    };
  }

  private async inferDietaryTags(
    pastOrders: Awaited<ReturnType<OrderRepository["getByUser"]>>,
  ): Promise<string[]> {
    const tagCounts = new Map<string, number>();
    for (const order of pastOrders) {
      for (const item of order.items) {
        const menuItem = await this.catalogRepo.getMenuItemById(item.menu_item_id);
        for (const [tag, on] of Object.entries(menuItem?.dietary_tags ?? {})) {
          if (on) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + item.quantity);
        }
      }
    }
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag)
      .slice(0, 3);
  }

  private ruleScore(
    restaurant: RestaurantDTO,
    menu: Array<{ dietary_tags: Record<string, boolean>; is_available: boolean }>,
    dietaryMatch: number,
    tod: TimeOfDay,
  ): number {
    let score = 1;

    // Location proximity (closer = higher). 1/(1+d) is [0.5, 1] for 0-1 km.
    if (restaurant.lat !== null && restaurant.lng !== null) {
      const distance = haversineKm(DEFAULT_CONSUMER_LOCATION, {
        lat: restaurant.lat,
        lng: restaurant.lng,
      });
      score *= 1 / (1 + distance);
    } else {
      score *= 0.5;
    }

    // Dietary match: fraction of the menu satisfying every inferred tag.
    score *= 0.6 + 0.4 * dietaryMatch;

    // Time-of-day dietary boost (avg over the menu's dietary tags).
    score *= this.menuDietaryBoost(menu, tod);

    return score;
  }

  private dietaryMatch(
    menu: Array<{ dietary_tags: Record<string, boolean>; is_available: boolean }>,
    inferredTags: string[],
  ): number {
    if (inferredTags.length === 0 || menu.length === 0) return 0.5;
    const available = menu.filter((m) => m.is_available);
    if (available.length === 0) return 0;
    const matched = available.filter((m) =>
      inferredTags.every((tag) => m.dietary_tags[tag] === true),
    ).length;
    return matched / available.length;
  }

  private menuDietaryBoost(
    menu: Array<{ dietary_tags: Record<string, boolean> }>,
    tod: TimeOfDay,
  ): number {
    if (menu.length === 0) return 1;
    const factors: number[] = [];
    for (const [tag, factor] of Object.entries(TOD_DIETARY_BOOST[tod])) {
      const hasTag = menu.some((m) => m.dietary_tags[tag] === true);
      if (hasTag) factors.push(factor);
    }
    if (factors.length === 0) return 1;
    return factors.reduce((s, f) => s + f, 0) / factors.length;
  }

  /** Warm-tier affinity: frequency + recency of the user's past orders. */
  private pastRestaurantAffinity(
    restaurantId: string,
    pastOrders: Awaited<ReturnType<OrderRepository["getByUser"]>>,
  ): number {
    const ordered = pastOrders
      .filter((o) => o.restaurant_id === restaurantId)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    if (ordered.length === 0) return 0;
    // Recency-weighted: most recent order carries the highest weight.
    let weighted = 0;
    ordered.forEach((_, i) => {
      weighted += pastOrders.length - i;
    });
    return weighted / pastOrders.length;
  }

  private pickReason(
    restaurant: RestaurantDTO,
    mlAffinity: number,
    tod: TimeOfDay,
  ): string {
    if (mlAffinity > 0) return "You order here often";
    if (restaurant.lat !== null && restaurant.lng !== null) {
      const distance = haversineKm(DEFAULT_CONSUMER_LOCATION, {
        lat: restaurant.lat,
        lng: restaurant.lng,
      });
      if (distance < 3) return "Near you";
    }
    return `Popular ${tod === "late_night" ? "late night" : tod}`;
  }

  // ==================== D17 Trending Now ====================

  async getTrending(options?: {
    radiusKm?: number;
    minutes?: number;
    lat?: number;
    lng?: number;
  }): Promise<TrendingResponse> {
    const radiusKm = options?.radiusKm ?? DEFAULT_TRENDING_RADIUS_KM;
    const minutes = options?.minutes ?? DEFAULT_TRENDING_MINUTES;
    const location = {
      lat: options?.lat ?? DEFAULT_CONSUMER_LOCATION.lat,
      lng: options?.lng ?? DEFAULT_CONSUMER_LOCATION.lng,
    };

    const cutoffMs = Date.now() - minutes * 60_000;

    const restaurants = await this.catalogRepo.getActiveRestaurants();
    const restaurantsInRadius = restaurants.filter((r) => {
      if (r.lat === null || r.lng === null) return false;
      return haversineKm(location, { lat: r.lat, lng: r.lng }) <= radiusKm;
    });

    // Aggregate per menu item across in-radius restaurants.
    const byItem = new Map<
      string,
      {
        menu_item_id: string;
        name: string;
        price: number;
        restaurant_id: string;
        restaurant_name: string;
        orders_count: number;
        quantity_sold: number;
      }
    >();

    for (const restaurant of restaurantsInRadius) {
      const orders = await this.orderRepo.getByRestaurant(restaurant.id);
      for (const order of orders) {
        if (DISALLOWED_TRENDING_STATUSES.has(order.status)) continue;
        if (new Date(order.created_at).getTime() < cutoffMs) continue; // time bound
        const seen = new Set<string>();
        for (const item of order.items) {
          const entry = byItem.get(item.menu_item_id) ?? {
            menu_item_id: item.menu_item_id,
            name: item.name,
            price: item.base_price,
            restaurant_id: restaurant.id,
            restaurant_name: restaurant.name,
            orders_count: 0,
            quantity_sold: 0,
          };
          entry.quantity_sold += item.quantity;
          if (!seen.has(item.menu_item_id)) {
            entry.orders_count += 1;
            seen.add(item.menu_item_id);
          }
          byItem.set(item.menu_item_id, entry);
        }
      }
    }

    const trending = Array.from(byItem.values())
      .sort(
        (a, b) =>
          b.quantity_sold - a.quantity_sold ||
          b.orders_count - a.orders_count,
      )
      .slice(0, TRENDING_TOP_N);

    await emit(
      createEventEnvelope("TrendingQueried", "discovery", {
        radius_km: radiusKm,
        minutes,
        result_count: trending.length,
      }),
    );

    logger.info({
      message: "trending_queried",
      radius_km: radiusKm,
      minutes,
      results: trending.length,
    });

    return {
      window_minutes: minutes,
      radius_km: radiusKm,
      location,
      generated_at: new Date().toISOString(),
      trending,
    };
  }

  // ==================== D04 Hyperlocal Heatmap ====================

  /**
   * Aggregates real-time order density over the last `minutes` (default 30)
   * into lightweight ~110 m grid cells (coordinates rounded to 3 decimals).
   * Only real fulfillment states count (abandoned carts excluded), exactly
   * mirroring the trending status filter. Response stays O(cells).
   */
  async getHeatmap(minutes = DEFAULT_HEATMAP_MINUTES): Promise<HeatmapResult> {
    const cutoffMs = Date.now() - minutes * 60_000;

    const restaurants = await this.catalogRepo.getActiveRestaurants();
    const byCell = new Map<string, { lat: number; lng: number; count: number }>();

    for (const restaurant of restaurants) {
      if (restaurant.lat === null || restaurant.lng === null) continue;
      const orders = await this.orderRepo.getByRestaurant(restaurant.id);
      let cellCount = 0;
      for (const order of orders) {
        if (DISALLOWED_TRENDING_STATUSES.has(order.status)) continue;
        if (new Date(order.created_at).getTime() < cutoffMs) continue;
        cellCount += 1;
      }
      if (cellCount === 0) continue;

      const key = `${restaurant.lat.toFixed(3)},${restaurant.lng.toFixed(3)}`;
      const existing = byCell.get(key);
      if (existing) {
        existing.count += cellCount;
      } else {
        byCell.set(key, {
          lat: roundTo(restaurant.lat, 3),
          lng: roundTo(restaurant.lng, 3),
          count: cellCount,
        });
      }
    }

    const cells = Array.from(byCell.values()).sort(
      (a, b) => b.count - a.count || a.lat - b.lat,
    );
    const totalOrders = cells.reduce((sum, c) => sum + c.count, 0);

    await emit(
      createEventEnvelope("HeatmapQueried", "discovery", {
        window_minutes: minutes,
        cell_count: cells.length,
        total_orders: totalOrders,
      }),
    );

    logger.info({
      message: "heatmap_queried",
      window_minutes: minutes,
      cells: cells.length,
      total_orders: totalOrders,
    });

    return {
      window_minutes: minutes,
      total_orders: totalOrders,
      generated_at: new Date().toISOString(),
      cells,
    };
  }
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface HeatmapCell {
  lat: number;
  lng: number;
  count: number;
}

export interface HeatmapResult {
  window_minutes: number;
  total_orders: number;
  generated_at: string;
  cells: HeatmapCell[];
}
