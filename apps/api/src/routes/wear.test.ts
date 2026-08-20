import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedOrderRepo } from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// W14 Smart Watch App - GET/POST /api/v1/wear/orders/*
// Minimal payload strategy: flat objects, < 500 bytes, no heavy objects.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000f1";

function auth(userId: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_wear_test_12345",
    })}`,
  };
}

function seedOrder(
  id: string,
  status: OrderDTO["status"] = "CONFIRMED",
  scheduledPickupTime: string | null = "2026-08-06T12:30:00+05:30",
): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: USER,
    restaurant_id: REST_ID,
    items: [
      {
        id: `itm-${id}`,
        menu_item_id: CHICKEN_BIRYANI,
        name: "Chicken Biryani",
        base_price: 220,
        quantity: 1,
        customizations: [],
        customization_total: 0,
        item_subtotal: 220,
        gift_id: null,
      },
    ],
    total_amount: 220,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: scheduledPickupTime,
    created_at: "2026-08-06T10:00:00.000Z",
    updated_at: "2026-08-06T10:00:00.000Z",
  });
}

describe("W14 Smart Watch API", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    app = createApp();
  });

  describe("GET /api/v1/wear/orders/active", () => {
    it("rejects unauthenticated requests (401)", async () => {
      await request(app).get("/api/v1/wear/orders/active").expect(401);
    });

    it("returns a strictly minimal payload under 500 bytes", async () => {
      seedOrder("w1", "READY_FOR_PICKUP");

      const res = await request(app)
        .get("/api/v1/wear/orders/active")
        .set(auth(USER))
        .expect(200);

      const d = res.body.data;
      expect(d.active_orders).toHaveLength(1);
      const order = d.active_orders[0];
      // ONLY the glanceable fields - no items, no prices, no PII.
      expect(Object.keys(order).sort()).toEqual([
        "order_id",
        "pickup_time",
        "restaurant_name",
        "status",
      ]);
      expect(order.restaurant_name).toBe("Biryani House");
      expect(order.status).toBe("READY_FOR_PICKUP");
      expect(order.pickup_time).toBe("2026-08-06T12:30:00+05:30");

      expect(JSON.stringify(d).length).toBeLessThan(500);
    });

    it("excludes terminal orders", async () => {
      seedOrder("w1", "PICKED_UP");
      seedOrder("w2", "CANCELLED");

      const res = await request(app)
        .get("/api/v1/wear/orders/active")
        .set(auth(USER))
        .expect(200);
      expect(res.body.data.active_orders).toHaveLength(0);
    });
  });

  describe("POST /api/v1/wear/orders/reorder", () => {
    it("rejects unauthenticated requests (401)", async () => {
      await request(app).post("/api/v1/wear/orders/reorder").expect(401);
    });

    it("one-tap reorders the latest order with a minimal confirmation", async () => {
      seedOrder("w1", "PICKED_UP");

      const res = await request(app)
        .post("/api/v1/wear/orders/reorder")
        .set(auth(USER))
        .expect(201);

      const d = res.body.data;
      expect(Object.keys(d).sort()).toEqual(["order_id", "status", "total_amount"]);
      expect(d.status).toBe("DRAFT");
      // 220 food + 10 packaging + 11 GST(food) + 1.8 GST(packaging) = 242.8
      expect(d.total_amount).toBe(242.8);
      expect(JSON.stringify(d).length).toBeLessThan(500);

      // A brand-new order was created for the same restaurant.
      const byUser = await sharedOrderRepo.getByUser(USER);
      expect(byUser).toHaveLength(2);
    });

    it("returns 404 when the user has no previous order", async () => {
      const res = await request(app)
        .post("/api/v1/wear/orders/reorder")
        .set(auth(USER))
        .expect(404);
      expect(res.body.error.code).toBe("NO_ORDERS");
    });
  });
});
