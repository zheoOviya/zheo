import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedAuditRepo, sharedOrderRepo } from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import { calculatePriceBreakdown } from "../services/pricing";

// ============================================
// W12 Catering Orders - POST /api/v1/orders/catering
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";
const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001"; // 220, Biryani House
const VEG_BIRYANI = "b0000000-0000-4000-8000-000000000002"; // 180, Biryani House
const PANEER_WRAP = "b0000000-0000-4000-8000-000000000003"; // 160, Green Bowl
const CUSTOMER = "00000000-0000-4000-8000-0000000000f1";

function auth(userId: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_catering_test_1",
    })}`,
  };
}

const FUTURE = "2099-09-01T10:30:00+05:30";

function cateringPayload(overrides: Record<string, unknown> = {}) {
  return {
    restaurant_id: REST_ID,
    event_date: FUTURE,
    headcount: 150,
    budget: 50000,
    special_instructions: "Arrive by 9:45 AM; set up buffet counter",
    items: [
      { menu_item_id: CHICKEN_BIRYANI, quantity: 100, unit_price: 200, description: "Extra saffron" },
      { menu_item_id: VEG_BIRYANI, quantity: 50 },
    ],
    ...overrides,
  };
}

describe("W12 Catering Orders", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    app = createApp();
  });

  it("rejects unauthenticated requests (401)", async () => {
    await request(app)
      .post("/api/v1/orders/catering")
      .send(cateringPayload())
      .expect(401);
  });

  it("rejects headcount below 50 (400)", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ headcount: 49 }))
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a past event date (400)", async () => {
    await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ event_date: "2020-01-01T10:00:00+05:30" }))
      .expect(400);
  });

  it("creates a flagged CONFIRMED catering order with bulk quantities", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload())
      .expect(201);

    const d = res.body.data;
    expect(d.is_catering).toBe(true);
    expect(d.headcount).toBe(150);
    expect(d.status).toBe("CONFIRMED");
    expect(d.items).toHaveLength(2);

    // Custom bulk pricing honored: 100 x 200 + 50 x 180 via the pricing engine.
    const expected = calculatePriceBreakdown([
      { menu_item_id: CHICKEN_BIRYANI, name: "Chicken Biryani (Extra saffron)", base_price: 200, quantity: 100, customizations: [] },
      { menu_item_id: VEG_BIRYANI, name: "Veg Biryani", base_price: 180, quantity: 50, customizations: [] },
    ]).total_amount;
    expect(d.total_amount).toBe(expected);

    const chicken = d.items.find(
      (i: { name: string }) => i.name.startsWith("Chicken Biryani"),
    );
    expect(chicken.quantity).toBe(100);

    // The order persists on the aggregate with catering flags intact.
    const fetched = await request(app)
      .get(`/api/v1/orders/${d.id}`)
      .set(auth(CUSTOMER))
      .expect(200);
    expect(fetched.body.data.is_catering).toBe(true);
    expect(fetched.body.data.headcount).toBe(150);
  });

  it("bypasses the standard 50 per-line cap (quantity up to 1000)", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 999 }] }))
      .expect(201);
    expect(res.body.data.items[0].quantity).toBe(999);
  });

  it("returns 404 for an unknown restaurant", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ restaurant_id: "a0000000-0000-4000-8000-00000000ffff" }))
      .expect(404);
    expect(res.body.error.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("rejects a line item not owned by the target restaurant (400)", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ items: [{ menu_item_id: PANEER_WRAP, quantity: 50 }] }))
      .expect(400);
    expect(res.body.error.code).toBe("ITEM_RESTAURANT_MISMATCH");
  });

  it("rejects an unknown menu item (404)", async () => {
    await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload({ items: [{ menu_item_id: "b0000000-0000-4000-8000-00000000ffff", quantity: 50 }] }))
      .expect(404);
  });

  it("audits the catering order creation", async () => {
    const res = await request(app)
      .post("/api/v1/orders/catering")
      .set(auth(CUSTOMER))
      .send(cateringPayload())
      .expect(201);

    const logs = await sharedAuditRepo.all();
    const cateringLog = logs.find((l) => l.action === "catering_order_created");
    expect(cateringLog).toBeDefined();
    expect(cateringLog?.metadata).toMatchObject({
      order_id: res.body.data.id,
      headcount: 150,
      is_catering: true,
      status: "CONFIRMED",
    });
  });
});
