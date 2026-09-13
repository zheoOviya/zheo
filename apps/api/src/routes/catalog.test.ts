import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";
import { resetCatalogRepository } from "./catalog";
import { getRedis, resetRedisForTests } from "../lib/redis";
import { dietaryFilterCondition } from "../repositories/catalogRepository";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";

// MENU-ROUTE-PROJECTION-A2: the exact public MenuItemSchema key set.
const PUBLIC_MENU_KEYS = [
  "id",
  "restaurant_id",
  "name",
  "price",
  "dietary_tags",
  "customizations",
  "image_url",
  "is_available",
  "spice_level",
].sort();

function expectPublicMenuKeys(items: Record<string, unknown>[]) {
  for (const item of items) {
    expect(Object.keys(item).sort()).toEqual(PUBLIC_MENU_KEYS);
    expect(Object.prototype.hasOwnProperty.call(item, "description")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "pos_item_id")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(item, "created_at")).toBe(false);
  }
}

describe("Catalog context routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    app = createApp();
  });

  it("GET /restaurants returns only active restaurants", async () => {
    const res = await request(app).get("/api/v1/restaurants").expect(200);
    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain("Biryani House");
    expect(names).toContain("Green Bowl");
    expect(names).not.toContain("Closed Kitchen");
  });

  // PUBLIC-RESTAURANT-DTO-A2 (U1): the public list must never serialize the
  // internal, non-authoritative `commission_rate` config.
  it("GET /restaurants omits commission_rate from every restaurant", async () => {
    const res = await request(app).get("/api/v1/restaurants").expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const r of res.body.data as Record<string, unknown>[]) {
      expect(Object.prototype.hasOwnProperty.call(r, "commission_rate")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "commission_amount")).toBe(false);
    }
    expect(JSON.stringify(res.body)).not.toContain("commission_rate");
  });

  it("GET /restaurants/:id/menu returns available menu items", async () => {
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/menu`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it("GET /restaurants/:id/menu rejects invalid uuid", async () => {
    const res = await request(app)
      .get("/api/v1/restaurants/not-a-uuid/menu")
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // MENU-ROUTE-PROJECTION-A2 (U1,U3,U4,U5,U6): the menu endpoint returns the
  // parsed public MenuItem projection, not the raw repository DTO.
  it("GET /restaurants/:id/menu returns exactly the public MenuItem contract", async () => {
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/menu`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expectPublicMenuKeys(res.body.data);
    // Public fields are retained with real values.
    const names = res.body.data.map((m: { name: string }) => m.name);
    expect(names).toContain("Chicken Biryani");
    const biryani = res.body.data.find(
      (m: { name: string }) => m.name === "Chicken Biryani",
    );
    expect(biryani.price).toBe(220);
    expect(biryani.restaurant_id).toBe(REST_ID);
    expect(JSON.stringify(res.body)).not.toContain("pos_item_id");
  });

  it("GET /search/autocomplete matches restaurants and dishes", async () => {
    const res = await request(app)
      .get("/api/v1/search/autocomplete?q=biryani")
      .expect(200);
    expect(res.body.success).toBe(true);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain("Biryani House");
    expect(names).toContain("Chicken Biryani");
    expect(names).toContain("Veg Biryani");
  });

  it("GET /search/autocomplete requires q", async () => {
    const res = await request(app).get("/api/v1/search/autocomplete").expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  describe("D05 dietary filter (GIN index)", () => {
    it("filters by a single VEG tag", async () => {
      const res = await request(app)
        .get("/api/v1/menu-items/filter?dietary=VEG")
        .expect(200);
      expect(res.body.success).toBe(true);
      const names = res.body.data.map((m: { name: string }) => m.name);
      expect(names).toContain("Veg Biryani");
      expect(names).toContain("Paneer Wrap");
      expect(names).not.toContain("Chicken Biryani");
      // unavailable items must never appear
      expect(names).not.toContain("Unavailable Dish");
    });

    it("filters by the intersection of VEG,JAIN (containment)", async () => {
      const res = await request(app)
        .get("/api/v1/menu-items/filter?dietary=VEG,JAIN")
        .expect(200);
      expect(res.body.success).toBe(true);
      const names = res.body.data.map((m: { name: string }) => m.name);
      expect(names).toEqual(["Veg Biryani"]);
    });

    it("filters by JAIN", async () => {
      const res = await request(app)
        .get("/api/v1/menu-items/filter?dietary=JAIN")
        .expect(200);
      const names = res.body.data.map((m: { name: string }) => m.name);
      expect(names).toEqual(["Veg Biryani"]);
    });

    it("rejects unknown dietary tags", async () => {
      const res = await request(app)
        .get("/api/v1/menu-items/filter?dietary=GLUTEN")
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    // MENU-ROUTE-PROJECTION-A2 (U2,U3,U4,U5,U6): the filter endpoint returns
    // the parsed public MenuItem projection, not the raw repository DTO.
    it("returns exactly the public MenuItem contract", async () => {
      const res = await request(app)
        .get("/api/v1/menu-items/filter?dietary=VEG")
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expectPublicMenuKeys(res.body.data);
      const veg = res.body.data.find(
        (m: { name: string }) => m.name === "Veg Biryani",
      );
      expect(veg.price).toBe(180);
      expect(veg.is_available).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("pos_item_id");
    });

    it("builds a query using the GIN @> operator on dietary_tags", () => {
      const cond = dietaryFilterCondition(["VEG", "JAIN"]) as unknown as {
        queryChunks: { constructor: { name: string }; value?: unknown }[];
      };
      const parts = cond.queryChunks.map((chunk) =>
        chunk.constructor.name === "StringChunk"
          ? String(chunk.value)
          : `[${chunk.constructor.name}]`,
      );
      expect(parts.join(" ")).toContain("@>");
      expect(parts).toContain("[PgJsonb]"); // dietary_tags column
      expect(parts.join(" ")).toContain("::jsonb");
    });
  });

  describe("Redis cache-aside", () => {
    it("caches restaurants under cache:catalog:restaurants", async () => {
      await request(app).get("/api/v1/restaurants").expect(200);
      const redis = getRedis();
      const cached = await redis.get("cache:catalog:restaurants");
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached as string);
      expect(parsed).toHaveLength(2);
    });

    it("caches menu per restaurant", async () => {
      await request(app).get(`/api/v1/restaurants/${GREEN_BOWL_ID}/menu`).expect(200);
      const cached = await getRedis().get(
        `cache:catalog:menu:${GREEN_BOWL_ID}`,
      );
      expect(cached).not.toBeNull();
    });

    it("caches autocomplete results per query for 1 min", async () => {
      await request(app).get("/api/v1/search/autocomplete?q=paneer").expect(200);
      const cached = await getRedis().get("cache:catalog:search:paneer");
      expect(cached).not.toBeNull();
    });

    it("caches filter results per dietary combination", async () => {
      await request(app).get("/api/v1/menu-items/filter?dietary=JAIN").expect(200);
      const cached = await getRedis().get("cache:catalog:filter:JAIN");
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached as string);
      expect(parsed[0].name).toBe("Veg Biryani");
    });
  });
});
