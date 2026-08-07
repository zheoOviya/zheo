import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";

// ============================================
// O09 Cart Persistence routes (POST/GET/DELETE /api/v1/cart)
// ============================================

const USER_ID = "00000000-0000-4000-8000-0000000000f1";
const MENU_ITEM = "b0000000-0000-4000-8000-000000000001";
const REST_ID = "a0000000-0000-4000-8000-000000000001";

function authHeaders(userId?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? USER_ID,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

describe("Cart persistence routes (O09)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  it("GET returns an empty cart before anything is saved", async () => {
    const res = await request(app)
      .get("/api/v1/cart")
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.expired).toBe(false);
    expect(res.body.data.saved_at).toBeNull();
  });

  it("POST then GET round-trips the cart", async () => {
    await request(app)
      .post("/api/v1/cart")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        restaurant_name: "Biryani House",
        items: [
          {
            menu_item_id: MENU_ITEM,
            quantity: 2,
            name: "Chicken Biryani",
            base_price: 220,
          },
        ],
      })
      .expect(200);

    const res = await request(app)
      .get("/api/v1/cart")
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.expired).toBe(false);
    expect(res.body.data.restaurant_id).toBe(REST_ID);
    expect(res.body.data.restaurant_name).toBe("Biryani House");
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      menu_item_id: MENU_ITEM,
      quantity: 2,
      name: "Chicken Biryani",
    });
    expect(res.body.data.saved_at).toBeTruthy();
  });

  it("carts are scoped per user", async () => {
    await request(app)
      .post("/api/v1/cart")
      .set(authHeaders(USER_ID))
      .send({ items: [{ menu_item_id: MENU_ITEM, quantity: 1 }] })
      .expect(200);

    const other = await request(app)
      .get("/api/v1/cart")
      .set(authHeaders("00000000-0000-4000-8000-0000000000f2"))
      .expect(200);
    expect(other.body.data.items).toEqual([]);
  });

  it("DELETE clears the cart", async () => {
    await request(app)
      .post("/api/v1/cart")
      .set(authHeaders())
      .send({ items: [{ menu_item_id: MENU_ITEM, quantity: 1 }] })
      .expect(200);

    await request(app).delete("/api/v1/cart").set(authHeaders()).expect(200);

    const res = await request(app)
      .get("/api/v1/cart")
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("accepts an empty cart save (clear) and stores it", async () => {
    await request(app)
      .post("/api/v1/cart")
      .set(authHeaders())
      .send({ items: [] })
      .expect(200);

    const res = await request(app)
      .get("/api/v1/cart")
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("requires authentication", async () => {
    await request(app).get("/api/v1/cart").expect(401);
    await request(app).post("/api/v1/cart").send({ items: [] }).expect(401);
  });
});
