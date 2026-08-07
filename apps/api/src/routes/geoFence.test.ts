import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedOrderRepo } from "../repositories/shared";
import { resetCatalogRepository, getCatalogRepository } from "./catalog";
import { haversineKm } from "../services/discovery";

// ============================================
// P02 Geo-fence Detection (POST /api/v1/orders/:id/location-update)
// Within 100m + READY_FOR_PICKUP => auto check-in + UserArrivedAtRestaurant.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";
const USER_ID = "u00000000-0000-4000-8000-000000000001";

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
  await request(app).put(`/api/vendor/orders/${orderId}/status`).expect(200);
  await request(app).put(`/api/vendor/orders/${orderId}/status`).expect(200);
  await request(app).put(`/api/vendor/orders/${orderId}/status`).expect(200);
  return orderId;
}

describe("Geo-fence routes (P02)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    resetCatalogRepository();
    app = createApp();
  });

  it("within 100m and READY_FOR_PICKUP auto-checks-in", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const orderId = await createReadyOrder(app);
    const near = { lat: restaurant.lat! + 0.0004, lng: restaurant.lng! };

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: near.lat, lng: near.lng })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.within_fence).toBe(true);
    expect(res.body.data.auto_checked_in).toBe(true);
    expect(res.body.data.checked_in).toBe(true);
    expect(res.body.data.distance_m).toBeLessThanOrEqual(100);
    expect(res.body.data.distance_m).toBeGreaterThan(0);

    const stored = await sharedOrderRepo.getById(orderId);
    expect(stored?.checked_in).toBe(true);
  });

  it("beyond 100m is ignored (no check-in)", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const restaurantLoc = { lat: restaurant.lat!, lng: restaurant.lng! };
    const orderId = await createReadyOrder(app);
    const far = { lat: restaurant.lat! + 0.02, lng: restaurant.lng! };
    const distanceM = haversineKm(far, restaurantLoc) * 1000;

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: far.lat, lng: far.lng })
      .expect(200);

    expect(res.body.data.within_fence).toBe(false);
    expect(res.body.data.auto_checked_in).toBe(false);
    expect(res.body.data.distance_m).toBeGreaterThan(100);
    expect(distanceM).toBeGreaterThan(100);

    const stored = await sharedOrderRepo.getById(orderId);
    expect(stored?.checked_in).toBe(false);
  });

  it("within fence but not READY_FOR_PICKUP does not auto-check-in", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const orderRes = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(201);
    const orderId = orderRes.body.data.id;
    await sharedOrderRepo.updateStatus(orderId, "PREPARING");

    const near = { lat: restaurant.lat! + 0.0004, lng: restaurant.lng! };
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: near.lat, lng: near.lng })
      .expect(200);

    expect(res.body.data.within_fence).toBe(true);
    expect(res.body.data.auto_checked_in).toBe(false);
    expect(res.body.data.checked_in).toBe(false);
  });

  it("rejects invalid coordinates", async () => {
    const orderId = await createReadyOrder(app);
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: 999, lng: 0 })
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 for an unknown order", async () => {
    await request(app)
      .post("/api/v1/orders/00000000-0000-4000-8000-00000000dead/location-update")
      .set(authHeaders())
      .send({ lat: 19.076, lng: 72.8777 })
      .expect(404);
  });
});
