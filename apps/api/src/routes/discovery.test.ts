import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedOrderRepo } from "../repositories/shared";
import { resetCatalogRepository, getCatalogRepository } from "./catalog";

// ============================================
// Discovery routes (D07 Personalized Homepage + D17 Trending Now)
// Cold-start vs returning-user personalization, anti-filter-bubble,
// and time-bounded trending within a radius.
// ============================================

const BIRYANI_HOUSE = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL = "a0000000-0000-4000-8000-000000000002";

const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001";
const VEG_BIRYANI = "b0000000-0000-4000-8000-000000000002";
const PANEER_WRAP = "b0000000-0000-4000-8000-000000000003";
const HALAL_SHAWARMA = "b0000000-0000-4000-8000-000000000004";

const NON_VEG_USER = "00000000-0000-4000-8000-0000000000d1";
const EARLY_USER = "00000000-0000-4000-8000-0000000000d2";

function auth(userId: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543211",
      role: "CONSUMER",
      device_fingerprint: "fp_discovery_test_1234",
    })}`,
  };
}

async function placeConfirmedOrder(
  app: Express,
  userId: string,
  restaurantId: string,
  menuItemId: string,
) {
  const res = await request(app)
    .post("/api/v1/orders")
    .set(auth(userId))
    .send({
      restaurant_id: restaurantId,
      items: [{ menu_item_id: menuItemId, quantity: 1, customizations: [] }],
    })
    .expect(201);
  const orderId = res.body.data.id;
  await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");
  return orderId;
}

describe("Discovery routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    resetCatalogRepository();
    app = createApp();
  });

  describe("D07 GET /api/v1/discovery/personalized-homepage", () => {
    it("anonymous callers get the cold-start rule-based feed", async () => {
      const res = await request(app)
        .get("/api/v1/discovery/personalized-homepage")
        .expect(200);

      expect(res.body.data.user_profile).toMatchObject({
        is_cold_start: true,
        past_order_count: 0,
        strategy: "rule_based",
      });
      expect(res.body.data.personalized_restaurants.length).toBeGreaterThan(0);
      // Anti-filter-bubble: a surprise restaurant is always present.
      expect(res.body.data.surprise_restaurant).not.toBeNull();
      expect(res.body.data.surprise_restaurant.reason).toBe(
        "Something new for you",
      );
    });

    it("a user with 1-2 past orders stays in the rule-based tier", async () => {
      await placeConfirmedOrder(app, EARLY_USER, GREEN_BOWL, HALAL_SHAWARMA);

      const res = await request(app)
        .get("/api/v1/discovery/personalized-homepage")
        .set(auth(EARLY_USER))
        .expect(200);

      expect(res.body.data.user_profile).toMatchObject({
        is_cold_start: true,
        past_order_count: 1,
        strategy: "rule_based",
      });
    });

    it("a user with >= 3 past orders switches to the ML-weighted tier", async () => {
      for (let i = 0; i < 3; i += 1) {
        await placeConfirmedOrder(app, NON_VEG_USER, GREEN_BOWL, HALAL_SHAWARMA);
      }

      const res = await request(app)
        .get("/api/v1/discovery/personalized-homepage")
        .set(auth(NON_VEG_USER))
        .expect(200);

      expect(res.body.data.user_profile).toMatchObject({
        is_cold_start: false,
        past_order_count: 3,
        strategy: "ml_weighted",
      });
      // Dietary tags inferred from the shawarma orders.
      expect(res.body.data.user_profile.inferred_dietary_tags).toContain(
        "NON_VEG",
      );
      // The habitual restaurant rises to the top of the ranked feed.
      expect(res.body.data.personalized_restaurants[0].restaurant.id).toBe(
        GREEN_BOWL,
      );
      expect(
        res.body.data.personalized_restaurants[0].reason,
      ).toMatch(/You order here often/);
    });

    it("the surprise restaurant never duplicates the top picks", async () => {
      const res = await request(app)
        .get("/api/v1/discovery/personalized-homepage")
        .expect(200);

      const pickIds = res.body.data.personalized_restaurants.map(
        (p: { restaurant: { id: string } }) => p.restaurant.id,
      );
      const surpriseId = res.body.data.surprise_restaurant.restaurant.id;
      expect(pickIds).not.toContain(surpriseId);
    });
  });

  describe("D17 GET /api/v1/discovery/trending", () => {
    it("returns the top dishes within the radius, time-bounded to the window", async () => {
      // Recent orders inside the 60-minute window at both in-radius restaurants.
      await placeConfirmedOrder(app, NON_VEG_USER, BIRYANI_HOUSE, CHICKEN_BIRYANI);
      await placeConfirmedOrder(app, NON_VEG_USER, BIRYANI_HOUSE, CHICKEN_BIRYANI);
      await placeConfirmedOrder(app, NON_VEG_USER, BIRYANI_HOUSE, VEG_BIRYANI);
      await placeConfirmedOrder(app, EARLY_USER, GREEN_BOWL, PANEER_WRAP);

      const res = await request(app)
        .get(
          "/api/v1/discovery/trending?lat=19.076&lng=72.8777&radius_km=5&minutes=60",
        )
        .expect(200);

      expect(res.body.data.window_minutes).toBe(60);
      expect(res.body.data.radius_km).toBe(5);

      const trending = res.body.data.trending;
      // Chicken Biryani sold 2x -> ranks #1.
      expect(trending[0]).toMatchObject({
        menu_item_id: CHICKEN_BIRYANI,
        quantity_sold: 2,
        orders_count: 2,
        restaurant_id: BIRYANI_HOUSE,
      });
      const names = trending.map((t: { name: string }) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(["Chicken Biryani", "Veg Biryani", "Paneer Wrap"]),
      );
      // Bounded to top 5.
      expect(trending.length).toBeLessThanOrEqual(5);
    });

    it("ignores orders older than the window (time bound)", async () => {
      // Seed a 2-hour-old order directly (backdated created_at).
      const now = Date.now();
      sharedOrderRepo._seed({
        id: "00000000-0000-4000-8000-0000000000e1",
        user_id: NON_VEG_USER,
        restaurant_id: BIRYANI_HOUSE,
        items: [
          {
            id: "10000000-0000-4000-8000-0000000000e1",
            menu_item_id: CHICKEN_BIRYANI,
            name: "Chicken Biryani",
            base_price: 220,
            quantity: 5,
            customizations: [],
            customization_total: 0,
            item_subtotal: 1100,
          },
        ],
        total_amount: 1100,
        status: "CONFIRMED",
        commission_rate: 0.08,
        commission_amount: 88,
        pickup_otp: null,
        qr_token: null,
        checked_in: false,
        scheduled_pickup_time: null,
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      });

      const res = await request(app)
        .get(
          "/api/v1/discovery/trending?lat=19.076&lng=72.8777&radius_km=5&minutes=60",
        )
        .expect(200);

      const chicken = res.body.data.trending.find(
        (t: { menu_item_id: string }) => t.menu_item_id === CHICKEN_BIRYANI,
      );
      // The stale 5x order never appears in the 60-minute window.
      expect(chicken).toBeUndefined();
    });

    it("excludes restaurants outside the radius", async () => {
      // Green Bowl is ~4.2 km from the Biryani House origin -> inside a 5km
      // radius but OUTSIDE a 1km radius. Place an order there and at Biryani
      // House, then confirm only the in-radius restaurant contributes.
      await placeConfirmedOrder(app, NON_VEG_USER, GREEN_BOWL, PANEER_WRAP);
      await placeConfirmedOrder(app, NON_VEG_USER, BIRYANI_HOUSE, CHICKEN_BIRYANI);

      const narrow = await request(app)
        .get(
          "/api/v1/discovery/trending?lat=19.076&lng=72.8777&radius_km=1&minutes=60",
        )
        .expect(200);

      const narrowIds = narrow.body.data.trending.map(
        (t: { restaurant_id: string }) => t.restaurant_id,
      );
      expect(narrowIds).toContain(BIRYANI_HOUSE);
      expect(narrowIds).not.toContain(GREEN_BOWL);

      const wide = await request(app)
        .get(
          "/api/v1/discovery/trending?lat=19.076&lng=72.8777&radius_km=5&minutes=60",
        )
        .expect(200);

      const wideNames = wide.body.data.trending.map(
        (t: { name: string }) => t.name,
      );
      expect(wideNames).toContain("Paneer Wrap");
    });

    it("validates the query params", async () => {
      const res = await request(app)
        .get("/api/v1/discovery/trending?radius_km=-5")
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
