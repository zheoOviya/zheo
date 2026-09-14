import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { AppError } from "../middleware/envelope";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { getCatalogRepository, resetCatalogRepository } from "./catalog";
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

// IMAGE-STORAGE-TRUTH-A2: let a single test force the storage backend to fail
// so the real route's fail-before-persist ordering can be proven. `null` means
// "use the real MockImageStorage", which is what the non-production suite runs.
const storageOverride = vi.hoisted(() => ({
  current: null as
    | {
        upload: (
          buffer: Buffer,
          contentType: string,
          key: string,
        ) => Promise<string>;
      }
    | null,
}));

vi.mock("../services/imageStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/imageStorage")>();
  const realMock = new actual.MockImageStorage();
  return {
    ...actual,
    createImageStorage: () => ({
      upload: (buffer: Buffer, contentType: string, key: string) =>
        (storageOverride.current ?? realMock).upload(buffer, contentType, key),
    }),
  };
});

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
    storageOverride.current = null;
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  afterEach(() => {
    storageOverride.current = null;
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

  // IMAGE-STORAGE-TRUTH-A2: this suite runs with NODE_ENV=test, so the real
  // backend selection yields MockImageStorage (non-production). The synthetic
  // URL below is only acceptable in dev/test; production fails closed and is
  // covered by imageStorage.test.ts + the fail-closed route test that follows.
  it("POST /menu/:itemId/upload-photo persists the non-production mock CDN URL and audits it", async () => {
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

  it("T12 upload-photo: storage failure returns 503 and never persists or audits", async () => {
    storageOverride.current = {
      upload: async () => {
        throw new AppError(
          "IMAGE_STORAGE_UNCONFIGURED",
          "Menu photo storage is not configured for this environment",
          503,
        );
      },
    };

    const res = await request(app)
      .post(`/api/vendor/menu/${MENU_ITEM_1}/upload-photo`)
      .set(vendorAuthHeaders())
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: "biryani.jpg",
        contentType: "image/jpeg",
      })
      .expect(503);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("IMAGE_STORAGE_UNCONFIGURED");

    const menu = await request(app).get(`/api/vendor/menu?restaurant_id=${REST_ID}`).set(vendorAuthHeaders());
    const item = menu.body.data.find((m: { id: string }) => m.id === MENU_ITEM_1);
    expect(item.image_url).toBeNull();
    expect(await sharedAuditRepo.all()).toHaveLength(0);
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
      chain_id: null,
    });
    // A5 (RESTAURANT-COMMISSION-UI-TRUTH-A2): non-authoritative restaurant
    // commission config must not be exposed on the vendor read surface.
    expect(res.body.data[0]).not.toHaveProperty("commission_rate");
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

// ============================================
// GST_EXPORT_TRUTH_A2: statutory identity + copy truth
// ============================================
describe("Vendor GST export (GST_EXPORT_TRUTH_A2)", () => {
  let app: Express;
  const GSTIN = "27AABCB1234A1Z5";

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedUserRoleRepo._reset();
    sharedChainRepo._reset();
    app = createApp();
  });

  it("T8/T9: exports only PICKED_UP and SETTLED orders", async () => {
    seedOrder("o-picked", "2026-08-04T10:00:00.000Z", "PICKED_UP");
    seedOrder("o-settled", "2026-08-05T10:00:00.000Z", "SETTLED");
    seedOrder("o-preparing", "2026-08-06T10:00:00.000Z", "PREPARING");
    seedOrder("o-cancelled", "2026-08-07T10:00:00.000Z", "CANCELLED");

    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    const lines = res.text.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.split(",")[0]).toBe("o-picked");
    expect(lines[2]!.split(",")[0]).toBe("o-settled");
    expect(res.text).not.toContain("o-preparing");
    expect(res.text).not.toContain("o-cancelled");
  });

  it("T10: month filter stays creation-time based (UTC boundaries)", async () => {
    seedOrder("o-july", "2026-07-31T23:59:59.000Z", "PICKED_UP");
    seedOrder("o-aug", "2026-08-01T00:00:00.000Z", "PICKED_UP");
    seedOrder("o-sep", "2026-09-01T00:00:00.000Z", "PICKED_UP");

    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    const lines = res.text.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.split(",")[0]).toBe("o-aug");
  });

  it("T12: a missing GSTIN fails closed with no CSV", async () => {
    const restaurant = await getCatalogRepository().getRestaurantById(REST_ID);
    const original = restaurant!.gst_number;
    restaurant!.gst_number = null;
    try {
      seedOrder("o-aug", "2026-08-04T10:00:00.000Z", "PICKED_UP");
      const res = await request(app)
        .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${REST_ID}`)
        .set(vendorAuthHeaders());

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("GST_NUMBER_REQUIRED");
      expect(res.text).not.toContain("27MOCK");
      expect(res.text).not.toContain("Order Reference");
    } finally {
      restaurant!.gst_number = original;
    }
  });

  it("T13/T14: a valid GSTIN returns a neutral GST export CSV", async () => {
    seedOrder("o-aug", "2026-08-04T10:00:00.000Z", "PICKED_UP");

    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(
      'filename="gst-export-2026-08.csv"',
    );
    expect(res.headers["content-disposition"]).not.toContain("gstr1");

    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Order Reference,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
    // item_subtotal 450 -> CGST/SGST 11.25 each
    expect(lines[1]).toBe(`o-aug,${GSTIN},2026-08-04,450.00,11.25,11.25`);
  });

  it("T15: vendor ownership guard is unchanged", async () => {
    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${GREEN_BOWL_ID}`)
      .set(vendorAuthHeaders())
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});
