import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { getCatalogRepository, resetCatalogRepository } from "./catalog";
import {
  sharedIdentityRepo,
  sharedOrderRepo,
  sharedPosOrderRepo,
} from "../repositories/shared";

// ============================================
// Petpooja POS integration (V01) route tests
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const USER_ID = "u00000000-0000-4000-8000-000000000001";

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

const POS_ORDER_ID = "pp-order-20260804-001";

function buildPayload(overrides: Record<string, unknown> = {}): {
  payload: Record<string, unknown>;
  signature: string;
} {
  const payload = {
    pos_order_id: POS_ORDER_ID,
    restaurant_id: REST_ID,
    customer_phone: "919876543210",
    ordered_at: "2026-08-04T10:00:00.000Z",
    items: [
      { pos_item_id: "pp-3001", name: "Mutton Biryani", quantity: 2, price: 260, customizations: [] },
      { pos_item_id: "pp-4001", name: "Gobi Manchurian", quantity: 1, price: 150, customizations: [] },
    ],
    ...overrides,
  };
  return { payload, signature: "valid_sig_mock" };
}

describe("Petpooja POS webhook", () => {
  let app: Express;

  beforeEach(async () => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedPosOrderRepo._reset();
    sharedIdentityRepo._reset();
    app = createApp();

    // Every test starts with a synced POS menu so items resolve.
    await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
  });

  it("imports a signed POS order straight to CONFIRMED", async () => {
    const { payload, signature } = buildPayload();

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.processed).toBe(true);
    expect(res.body.data.idempotent).toBe(false);
    expect(res.body.data.order_status).toBe("CONFIRMED");
    expect(res.body.data.order_id).toBeTruthy();

    const order = await sharedOrderRepo.getById(res.body.data.order_id);
    expect(order?.status).toBe("CONFIRMED");
    expect(order?.total_amount).toBeGreaterThan(0);
  });

  it("is idempotent: a retried pos_order_id never creates a second order", async () => {
    const { payload, signature } = buildPayload();

    const first = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);
    expect(first.body.data.processed).toBe(true);

    const second = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);
    expect(second.body.data.processed).toBe(false);
    expect(second.body.data.idempotent).toBe(true);
    expect(second.body.data.order_id).toBe(first.body.data.order_id);

    const orders = await sharedOrderRepo.getByRestaurant(REST_ID);
    expect(orders).toHaveLength(1);
  });

  it("rejects a missing or invalid signature with 401", async () => {
    const { payload } = buildPayload();

    await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .send(payload)
      .expect(401);

    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", "tampered")
      .send(payload)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
  });

  it("rejects a malformed payload with 400", async () => {
    const { signature } = buildPayload();
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send({ pos_order_id: POS_ORDER_ID, items: [] })
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_WEBHOOK");
  });

  it("rejects items that have not been synced into the menu", async () => {
    const { payload, signature } = buildPayload({
      items: [{ pos_item_id: "pp-9999", name: "Unknown Dish", quantity: 1, price: 10, customizations: [] }],
    });
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(400);
    expect(res.body.error.code).toBe("POS_ITEM_NOT_SYNCED");
  });

  it("keys the customer on phone so POS and web orders share a user_id", async () => {
    const { payload, signature } = buildPayload();
    const res = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", signature)
      .send(payload)
      .expect(200);

    const order = await sharedOrderRepo.getById(res.body.data.order_id);
    const user = await sharedIdentityRepo.getByPhone("919876543210");
    expect(user).not.toBeNull();
    expect(order?.user_id).toBe(user?.id);

    // A second order from the same phone reuses the same user.
    const second = buildPayload({ pos_order_id: "pp-order-2" });
    const res2 = await request(app)
      .post("/api/v1/webhooks/pos/petpooja")
      .set("x-petpooja-signature", second.signature)
      .send(second.payload)
      .expect(200);
    const order2 = await sharedOrderRepo.getById(res2.body.data.order_id);
    expect(order2?.user_id).toBe(user?.id);
  });

  it("menu sync converges: a second sync never duplicates POS items", async () => {
    const repo = getCatalogRepository();
    const posItems = (items: { pos_item_id: string | null }[]) =>
      items.filter((i) => i.pos_item_id !== null).length;

    const afterFirst = posItems(await repo.getMenuAll(REST_ID));

    await request(app)
      .post(`/api/vendor/pos/sync-menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    const afterSecond = posItems(await repo.getMenuAll(REST_ID));

    expect(afterFirst).toBe(4);
    expect(afterSecond).toBe(4);
  });

  it("simulate-order syncs and imports an order end to end", async () => {
    const res = await request(app)
      .post(`/api/vendor/pos/simulate-order?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.body.data.menu_synced).toBe(4);
    expect(res.body.data.import.processed).toBe(true);
    expect(res.body.data.import.order_status).toBe("CONFIRMED");

    const order = await sharedOrderRepo.getById(res.body.data.import.order_id);
    expect(order).not.toBeNull();
    expect(order?.restaurant_id).toBe(REST_ID);
  });
});
