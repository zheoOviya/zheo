import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { onEvent } from "../lib/eventBus";
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
const OTHER_CONSUMER_ID = "u00000000-0000-4000-8000-000000000002";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

type CapturedEvent = { event_name: string; payload: Record<string, unknown> };
const captured: CapturedEvent[] = [];

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
      sub: userId ?? OWNER_ID,
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

describe("Geo-fence routes (P02)", () => {
  let app: Express;

  beforeAll(() => {
    onEvent("UserArrivedAtRestaurant", async (event) => {
      captured.push({
        event_name: event.event_name,
        payload: event.payload as Record<string, unknown>,
      });
    });
    onEvent("UserLocationObservedAtRestaurant", async (event) => {
      captured.push({
        event_name: event.event_name,
        payload: event.payload as Record<string, unknown>,
      });
    });
  });

  beforeEach(() => {
    captured.length = 0;
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

  it("forbids a foreign consumer and leaves checked_in untouched (403)", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const orderId = await createReadyOrder(app);
    const near = { lat: restaurant.lat! + 0.0004, lng: restaurant.lng! };

    const before = await sharedOrderRepo.getById(orderId);
    expect(before?.checked_in).toBe(false);

    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders(OTHER_CONSUMER_ID))
      .send({ lat: near.lat, lng: near.lng })
      .expect(403);

    expect(res.body.error.code).toBe("FORBIDDEN");

    const after = await sharedOrderRepo.getById(orderId);
    expect(after?.checked_in).toBe(false);
  });

  it("dually publishes legacy then successor with matching observation values", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const orderId = await createReadyOrder(app);
    const near = { lat: restaurant.lat! + 0.0004, lng: restaurant.lng! };

    await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: near.lat, lng: near.lng })
      .expect(200);

    expect(captured.map((e) => e.event_name)).toEqual([
      "UserArrivedAtRestaurant",
      "UserLocationObservedAtRestaurant",
    ]);
    const [legacy, successor] = captured;
    expect(successor?.payload).toEqual(legacy?.payload);
    expect(successor?.payload).toMatchObject({
      order_id: orderId,
      user_id: USER_ID,
      restaurant_id: REST_ID,
      within_fence: true,
      auto_checked_in: true,
    });

    const stored = await sharedOrderRepo.getById(orderId);
    expect(stored?.checked_in).toBe(true);
  });

  it("still emits the successor observation outside the fence", async () => {
    const restaurant = (await getCatalogRepository().getRestaurantById(REST_ID))!;
    const orderId = await createReadyOrder(app);
    const far = { lat: restaurant.lat! + 0.02, lng: restaurant.lng! };

    await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: far.lat, lng: far.lng })
      .expect(200);

    expect(captured.map((e) => e.event_name)).toEqual([
      "UserArrivedAtRestaurant",
      "UserLocationObservedAtRestaurant",
    ]);
    expect(captured[1]?.payload).toMatchObject({
      order_id: orderId,
      within_fence: false,
      auto_checked_in: false,
    });
    expect(captured[1]?.payload.distance_m).toBeGreaterThan(100);

    const stored = await sharedOrderRepo.getById(orderId);
    expect(stored?.checked_in).toBe(false);
  });

  it("still emits the successor observation when status is not READY_FOR_PICKUP", async () => {
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
    await request(app)
      .post(`/api/v1/orders/${orderId}/location-update`)
      .set(authHeaders())
      .send({ lat: near.lat, lng: near.lng })
      .expect(200);

    expect(captured.map((e) => e.event_name)).toEqual([
      "UserArrivedAtRestaurant",
      "UserLocationObservedAtRestaurant",
    ]);
    expect(captured[1]?.payload).toMatchObject({
      order_id: orderId,
      within_fence: true,
      auto_checked_in: false,
    });

    const stored = await sharedOrderRepo.getById(orderId);
    expect(stored?.checked_in).toBe(false);
  });
});
