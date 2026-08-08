import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedAuditRepo,
  sharedIdentityRepo,
  sharedLoyaltyRepo,
  sharedOrderRepo,
  sharedPromotionRepo,
} from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";

// ============================================
// Retention routes (O12 wallet + L02 streak) + D03 spice profile
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani (spice 5)
const USER_ID = "00000000-0000-4000-8000-0000000000e1";

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

function vendorAuthHeaders(userId?: string, role?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? USER_ID,
      phone: "+919876543210",
      role: role ?? "VENDOR_OWNER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

async function createReadyOrder(app: Express): Promise<string> {
  const orderRes = await request(app)
    .post("/api/v1/orders")
    .set(authHeaders())
    .send({
      restaurant_id: REST_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
    })
    .expect(201);
  const orderId = orderRes.body.data.id;
  await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");
  await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
  await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
  await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
  return orderId;
}

async function confirmPickup(app: Express, orderId: string): Promise<void> {
  const order = await sharedOrderRepo.getById(orderId);
  await request(app)
    .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
    .send({ pickup_otp: order?.pickup_otp })
    .expect(200);
}

describe("Retention routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    sharedLoyaltyRepo._reset();
    sharedAuditRepo._reset();
    sharedPromotionRepo._reset();
    sharedIdentityRepo._reset();
    resetCatalogRepository();
    sharedIdentityRepo._seed({
      id: USER_ID,
      phone: "+919876543210",
      role: "CONSUMER",
      created_at: new Date().toISOString(),
    });
    app = createApp();
  });

  it("GET /api/v1/loyalty/wallet reflects pickup cashback", async () => {
    const orderId = await createReadyOrder(app);
    const order = await sharedOrderRepo.getById(orderId);
    const expectedCashback = Math.round(order!.total_amount * 0.01 * 100) / 100;

    await confirmPickup(app, orderId);

    const res = await request(app)
      .get("/api/v1/loyalty/wallet")
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.balance).toBe(expectedCashback);
    expect(res.body.data.total_earned).toBe(expectedCashback);
    expect(res.body.data.transactions).toHaveLength(1);
    expect(res.body.data.transactions[0]).toMatchObject({
      reason: "pickup_cashback",
      amount: expectedCashback,
    });
  });

  it("GET /api/v1/loyalty/streak returns an initial streak", async () => {
    const orderId = await createReadyOrder(app);
    await confirmPickup(app, orderId);

    const res = await request(app)
      .get("/api/v1/loyalty/streak")
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.current_streak).toBe(1);
    expect(res.body.data.days_to_next_badge).toBe(6);
  });

  it("PUT /api/v1/users/profile persists spice tolerance", async () => {
    const res = await request(app)
      .put("/api/v1/users/profile")
      .set(authHeaders())
      .send({ spice_tolerance: 2 })
      .expect(200);

    expect(res.body.data.spice_tolerance).toBe(2);
  });

  it("rejects spice tolerance outside 1-5", async () => {
    await request(app)
      .put("/api/v1/users/profile")
      .set(authHeaders())
      .send({ spice_tolerance: 6 })
      .expect(400);
  });

  it("menu auto-filters items above the user's spice tolerance", async () => {
    await request(app)
      .put("/api/v1/users/profile")
      .set(authHeaders())
      .send({ spice_tolerance: 2 })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/menu`)
      .set(authHeaders())
      .expect(200);

    const names = res.body.data.map((m: { name: string; spice_level: number }) => ({
      name: m.name,
      spice_level: m.spice_level,
    }));
    expect(names.some((m: { name: string }) => m.name === "Chicken Biryani")).toBe(false);
    expect(names.some((m: { name: string }) => m.name === "Veg Biryani")).toBe(true);
    expect(names.every((m: { spice_level: number }) => m.spice_level <= 2)).toBe(true);
  });

  it("anonymous menu callers get the unfiltered menu", async () => {
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/menu`)
      .expect(200);
    const names = res.body.data.map((m: { name: string }) => m.name);
    expect(names).toContain("Chicken Biryani");
  });

  it("explicit spice_tolerance query param wins over profile", async () => {
    const GREEN_BOWL = "a0000000-0000-4000-8000-000000000002"; // Paneer Wrap spice 1, Shawarma spice 3
    await request(app)
      .put("/api/v1/users/profile")
      .set(authHeaders())
      .send({ spice_tolerance: 5 })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/restaurants/${GREEN_BOWL}/menu?spice_tolerance=1`)
      .set(authHeaders())
      .expect(200);
    const names = res.body.data.map((m: { name: string }) => m.name);
    expect(names).toEqual(["Paneer Wrap"]);
  });
});
