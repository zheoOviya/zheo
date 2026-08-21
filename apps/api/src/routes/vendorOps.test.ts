import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  sharedAuditRepo,
  sharedChainRepo,
  sharedOrderRepo,
  sharedUserRoleRepo,
} from "../repositories/shared";
import { makeChain } from "../repositories/chainRepository";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";

// ============================================
// Vendor Ops routes - V11 settlements, V13 menu photo upload, audit trail
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";
const CLOSED_KITCHEN_ID = "a0000000-0000-4000-8000-000000000003";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani
const MENU_ITEM_2 = "b0000000-0000-4000-8000-000000000002"; // Veg Biryani
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner
const STAFF_ID = "e0000000-0000-4000-a000-000000000099"; // scoped staff member

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

/** UTC day helpers so settlement tests stay valid on any run date. */
function utcDayOffset(daysBack: number): { ymd: string; noonIso: string } {
  const day = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() - daysBack,
    ),
  );
  return {
    ymd: day.toISOString().slice(0, 10),
    noonIso: new Date(day.getTime() + 12 * 60 * 60 * 1000).toISOString(),
  };
}

function item(overrides: Partial<OrderItemDTO>): OrderItemDTO {
  return {
    id: `itm-${Math.random()}`,
    menu_item_id: MENU_ITEM_1,
    name: "Chicken Biryani",
    base_price: 220,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: 220,
    gift_id: null,
    ...overrides,
  };
}

function seedOrder(
  id: string,
  createdAt: string,
  status: OrderDTO["status"] = "PICKED_UP",
  totalAmount = 500,
  restaurantId = REST_ID,
): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: "u00000000-0000-4000-8000-000000000001",
    restaurant_id: restaurantId,
    items: [item({ item_subtotal: 450 })],
    total_amount: totalAmount,
    status,
    commission_rate: 0.08,
    commission_amount: 40,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

describe("Vendor Ops routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  it("GET /settlements/summary only counts PICKED_UP orders from the previous day", async () => {
    const yesterday = utcDayOffset(1);
    const twoDaysAgo = utcDayOffset(2);
    seedOrder("o-yesterday", yesterday.noonIso);
    seedOrder("o-two-days-ago", twoDaysAgo.noonIso);
    seedOrder("o-still-cooking", yesterday.noonIso, "PREPARING");
    seedOrder("o-other-restaurant", yesterday.noonIso, "PICKED_UP", 500, GREEN_BOWL_ID);

    const res = await request(app)
      .get(`/api/vendor/settlements/summary?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.order_count).toBe(1);
    expect(res.body.data.lines[0].order_id).toBe("o-yesterday");
  });

  it("PUT /settlements/today streams a PDF and audits the download", async () => {
    const yesterday = utcDayOffset(1);
    seedOrder("o-yesterday", yesterday.noonIso);

    const res = await request(app)
      .put(`/api/vendor/settlements/today?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain(`filename="settlement-${yesterday.ymd}.pdf"`);
    expect(res.body).toBeInstanceOf(Buffer);
    expect(res.body.length).toBeGreaterThan(1000);
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");

    const audits = await sharedAuditRepo.all();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.action).toBe("settlement_downloaded");
    expect(audit.metadata.order_count).toBe(1);
  });

  it("GET /settlements/summary requires restaurant_id", async () => {
    const res = await request(app).get("/api/vendor/settlements/summary").set(vendorAuthHeaders()).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /menu lists items including unavailable ones and image_url", async () => {
    const res = await request(app)
      .get(`/api/vendor/menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty("image_url");
    expect(res.body.data[0]).toHaveProperty("is_available");
  });

  it("PUT /menu/:itemId updates price and audits the change", async () => {
    const res = await request(app)
      .put(`/api/vendor/menu/${MENU_ITEM_1}`)
      .send({ price: 240 })
      .set(vendorAuthHeaders())
      .expect(200);
    expect(res.body.data.price).toBe(240);

    const audits = await sharedAuditRepo.all();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.action).toBe("menu_updated");
    expect(audit.metadata.menu_item_id).toBe(MENU_ITEM_1);
    expect(audit.metadata.price).toBe(240);
  });

  it("PUT /menu/:itemId rejects an empty patch", async () => {
    const res = await request(app)
      .put(`/api/vendor/menu/${MENU_ITEM_1}`)
      .send({})
      .set(vendorAuthHeaders())
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /menu/:itemId/upload-photo persists a CDN URL and audits it", async () => {
    const res = await request(app)
      .post(`/api/vendor/menu/${MENU_ITEM_1}/upload-photo`)
      .set(vendorAuthHeaders())
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: "biryani.jpg",
        contentType: "image/jpeg",
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    const url: string = res.body.data.image_url;
    expect(url).toMatch(/^https:\/\/cdn\.snakzap\.in\/mock\/menu\/a0000000-0000-4000-8000-000000000001\/b0000000-0000-4000-8000-000000000001\/.+\.jpg$/);

    const menu = await request(app).get(`/api/vendor/menu?restaurant_id=${REST_ID}`).set(vendorAuthHeaders());
    const item = menu.body.data.find((m: { id: string }) => m.id === MENU_ITEM_1);
    expect(item.image_url).toBe(url);

    const audits = await sharedAuditRepo.all();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.action).toBe("menu_photo_uploaded");
    expect(audit.metadata.menu_item_id).toBe(MENU_ITEM_1);
    expect(audit.metadata.size_bytes).toBe(Buffer.from("fake-jpeg-bytes").length);
  });

  it("POST upload-photo rejects non-image files", async () => {
    const res = await request(app)
      .post(`/api/vendor/menu/${MENU_ITEM_1}/upload-photo`)
      .set(vendorAuthHeaders())
      .attach("photo", Buffer.from("text"), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await sharedAuditRepo.all()).toHaveLength(0);
  });

  it("POST upload-photo returns 404 for an unknown item", async () => {
    const res = await request(app)
      .post("/api/vendor/menu/99999999-0000-4000-8000-000000000099/upload-photo")
      .set(vendorAuthHeaders())
      .attach("photo", Buffer.from("fake"), {
        filename: "x.png",
        contentType: "image/png",
      })
      .expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("updates made by vendor are visible to the consumer menu", async () => {
    await request(app)
      .put(`/api/vendor/menu/${MENU_ITEM_2}`)
      .send({ is_available: false })
      .set(vendorAuthHeaders())
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/menu`)
      .expect(200);
    expect(res.body.data.map((m: { id: string }) => m.id)).not.toContain(MENU_ITEM_2);
  });
});

describe("Vendor multi-restaurant resolution", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  it("returns only the restaurants the vendor owns", async () => {
    const res = await request(app)
      .get("/api/vendor/restaurants")
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.body.success).toBe(true);
    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toEqual([REST_ID]);
    expect(ids).not.toContain(GREEN_BOWL_ID);
    expect(ids).not.toContain(CLOSED_KITCHEN_ID);
    expect(res.body.data[0]).toMatchObject({
      id: REST_ID,
      name: "Biryani House",
      is_active: true,
      commission_rate: 0.08,
      chain_id: null,
    });
  });

  it("includes restaurants granted via restaurant-scoped membership", async () => {
    await sharedUserRoleRepo.assign({
      user_id: STAFF_ID,
      scope_type: "restaurant",
      scope_id: GREEN_BOWL_ID,
      role: "VENDOR_STAFF",
    });

    const res = await request(app)
      .get("/api/vendor/restaurants")
      .set(vendorAuthHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);

    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toEqual([GREEN_BOWL_ID]);
  });

  it("includes chain outlets granted via chain-scoped membership", async () => {
    const chain = makeChain(
      "Franchise Co",
      "e0000000-0000-4000-a000-0000000000aa",
      "c0000000-0000-4000-8000-0000000000ff",
    );
    sharedChainRepo._seed(chain, [GREEN_BOWL_ID]);
    await sharedUserRoleRepo.assign({
      user_id: STAFF_ID,
      scope_type: "chain",
      scope_id: chain.id,
      role: "VENDOR_STAFF",
    });

    const res = await request(app)
      .get("/api/vendor/restaurants")
      .set(vendorAuthHeaders(STAFF_ID, "VENDOR_STAFF"))
      .expect(200);

    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toEqual([GREEN_BOWL_ID]);
    expect(res.body.data[0].chain_id).toBe(chain.id);
  });

  it("returns every restaurant for ADMIN platform oversight", async () => {
    const res = await request(app)
      .get("/api/vendor/restaurants")
      .set(vendorAuthHeaders("u-admin", "ADMIN"))
      .expect(200);

    const ids = res.body.data.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([REST_ID, GREEN_BOWL_ID, CLOSED_KITCHEN_ID].sort());
  });

  it("requires authentication", async () => {
    await request(app).get("/api/vendor/restaurants").expect(401);
  });

  it("forbids CONSUMER from listing vendor restaurants", async () => {
    const res = await request(app)
      .get("/api/vendor/restaurants")
      .set(vendorAuthHeaders("u-consumer", "CONSUMER"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
