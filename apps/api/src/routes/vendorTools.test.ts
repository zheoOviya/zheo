import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { resetCatalogRepository } from "./catalog";
import {
  sharedAuditRepo,
  sharedOrderRepo,
  sharedPromotionRepo,
} from "../repositories/shared";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";

// ============================================
// Vendor Tools - V12 GST export, V09 promotions, V14 bulk menu edit
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House
const GSTIN = "27AABCB1234A1Z5";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani 220
const MENU_ITEM_2 = "b0000000-0000-4000-8000-000000000002"; // Veg Biryani 180
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

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

function seedOrder(
  id: string,
  createdAt: string,
  status: OrderDTO["status"] = "PICKED_UP",
  itemSubtotal = 220,
  restaurantId = REST_ID,
): OrderDTO {
  const item: OrderItemDTO = {
    id: `itm-${id}`,
    menu_item_id: MENU_ITEM_1,
    name: "Chicken Biryani",
    base_price: itemSubtotal,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: itemSubtotal,
  };
  return sharedOrderRepo._seed({
    id,
    user_id: "u00000000-0000-4000-8000-000000000001",
    restaurant_id: restaurantId,
    items: [item],
    total_amount: itemSubtotal + 11,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

describe("Vendor Tools suite", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedPromotionRepo._reset();
    app = createApp();
  });

  // ---- V12: GST Export ------------------------------------------------------

  it("GET /gst-export streams a GSTR-1 CSV for the month", async () => {
    seedOrder("o-in-month-1", "2026-08-04T10:00:00.000Z", "PICKED_UP", 220);
    seedOrder("o-in-month-2", "2026-08-15T12:00:00.000Z", "SETTLED", 440);
    seedOrder("o-cooking", "2026-08-16T10:00:00.000Z", "PREPARING", 500);
    seedOrder("o-other-month", "2026-09-01T00:00:00.000Z", "PICKED_UP", 900);
    seedOrder("o-other-restaurant", "2026-08-10T10:00:00.000Z", "PICKED_UP", 700, "a0000000-0000-4000-8000-000000000002");

    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-08&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(
      'filename="gstr1-2026-08.csv"',
    );

    const lines = res.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Invoice No,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
    expect(lines).toHaveLength(3); // header + 2 eligible orders

    // 220 * 0.025 = 5.50; 440 * 0.025 = 11.00
    expect(lines[1]).toBe(
      `INV-2026-08-0001,${GSTIN},2026-08-04,220.00,5.50,5.50`,
    );
    expect(lines[2]).toBe(
      `INV-2026-08-0002,${GSTIN},2026-08-15,440.00,11.00,11.00`,
    );

    const audits = await sharedAuditRepo.all();
    const audit = audits.find((a) => a.action === "gst_export_downloaded");
    expect(audit?.metadata).toMatchObject({
      month: "2026-08",
      order_count: 2,
    });
  });

  it("GET /gst-export returns only the header when the month is empty", async () => {
    const res = await request(app)
      .get(`/api/vendor/gst-export?month=2026-01&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    expect(res.text.trim()).toBe(
      "Invoice No,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
  });

  it("GET /gst-export rejects an invalid month", async () => {
    const res = await request(app)
      .get(`/api/vendor/gst-export?month=not-a-month&restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ---- V09: Promotions ------------------------------------------------------

  it("POST /promotions creates a promotion and GET lists it as active", async () => {
    const created = await request(app)
      .post("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .send({
        title: "Monsoon Special",
        discount_type: "PERCENTAGE",
        value: 15,
        valid_until: "2027-01-31",
      })
      .expect(201);

    expect(created.body.data.title).toBe("Monsoon Special");
    expect(created.body.data.discount_type).toBe("PERCENTAGE");
    expect(created.body.data.value).toBe(15);

    const list = await request(app)
      .get("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].title).toBe("Monsoon Special");
  });

  it("GET /promotions excludes expired promotions", async () => {
    await request(app)
      .post("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .send({ title: "Expired Deal", discount_type: "FLAT", value: 50, valid_until: "2020-01-01" })
      .expect(201);
    await request(app)
      .post("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .send({ title: "Live Deal", discount_type: "FLAT", value: 40, valid_until: "2027-06-30" })
      .expect(201);

    const list = await request(app)
      .get("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].title).toBe("Live Deal");
  });

  it("POST /promotions rejects PERCENTAGE > 100", async () => {
    const res = await request(app)
      .post("/api/vendor/promotions")
      .set(vendorAuthHeaders())
      .send({ title: "Free-ish", discount_type: "PERCENTAGE", value: 150, valid_until: "2027-01-01" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ---- V14: Bulk Menu Edit --------------------------------------------------

  it("PUT /menu/bulk updates every row in one call", async () => {
    const res = await request(app)
      .put(`/api/vendor/menu/bulk?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .send({
        items: [
          { item_id: MENU_ITEM_1, price: 240, description: "Weekend biryani special" },
          { item_id: MENU_ITEM_2, price: 190, is_available: false },
        ],
      })
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].price).toBe(240);
    expect(res.body.data[0].description).toBe("Weekend biryani special");
    expect(res.body.data[1].price).toBe(190);
    expect(res.body.data[1].is_available).toBe(false);

    const menu = await request(app)
      .get(`/api/vendor/menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    const item1 = menu.body.data.find((m: { id: string }) => m.id === MENU_ITEM_1);
    const item2 = menu.body.data.find((m: { id: string }) => m.id === MENU_ITEM_2);
    expect(item1.price).toBe(240);
    expect(item1.description).toBe("Weekend biryani special");
    expect(item2.price).toBe(190);
    expect(item2.is_available).toBe(false);

    const audits = await sharedAuditRepo.all();
    const audit = audits.find((a) => a.action === "menu_bulk_updated");
    expect(audit?.metadata.item_count).toBe(2);
  });

  it("PUT /menu/bulk rolls back all rows when one item_id is invalid", async () => {
    const before = await request(app)
      .get(`/api/vendor/menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);

    const res = await request(app)
      .put(`/api/vendor/menu/bulk?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .send({
        items: [
          { item_id: MENU_ITEM_1, price: 999 },
          { item_id: UNKNOWN_ID, price: 1 },
        ],
      })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain(UNKNOWN_ID);

    // Zero rows changed - the valid row before the invalid one was rolled back.
    const after = await request(app)
      .get(`/api/vendor/menu?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .expect(200);
    expect(after.body.data).toEqual(before.body.data);

    const audits = await sharedAuditRepo.all();
    expect(audits.some((a) => a.action === "menu_bulk_updated")).toBe(false);
  });

  it("PUT /menu/bulk rejects a row that belongs to another restaurant", async () => {
    const res = await request(app)
      .put(`/api/vendor/menu/bulk?restaurant_id=${REST_ID}`)
      .set(vendorAuthHeaders())
      .send({
        items: [
          { item_id: "b0000000-0000-4000-8000-000000000003", price: 300 }, // Green Bowl item
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
