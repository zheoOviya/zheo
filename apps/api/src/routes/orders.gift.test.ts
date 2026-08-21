import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { orderRepo } from "./orders";
import { resetCatalogRepository } from "./catalog";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani Rs 220
const MENU_ITEM_2 = "b0000000-0000-4000-8000-000000000002"; // Veg Biryani Rs 180

const TEST_USER_ID = "u00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "u00000000-0000-4000-8000-000000000099";

function authToken(userId = TEST_USER_ID, role = "CONSUMER"): string {
  return jwtService.signAccessToken({
    sub: userId,
    phone: "+919876543210",
    role,
    device_fingerprint: "fp_test_device_abc1234",
  });
}

function authHeaders(userId?: string, role = "CONSUMER") {
  return { Authorization: `Bearer ${authToken(userId, role)}` };
}

/** Seeds a gift via the shared repo and marks it CLAIMED by `userId`. */
async function seedClaimedGift(
  userId: string,
  menuItemId = MENU_ITEM_1,
  restaurantId = REST_ID,
  customizations: { name: string; price_delta: number }[] = [],
): Promise<string> {
  const gift = await sharedGiftRepo.create({
    sender_id: "u00000000-0000-4000-8000-0000000000aa",
    restaurant_id: restaurantId,
    menu_item_id: menuItemId,
    item_snapshot: {
      name: "Chicken Biryani",
      price: 220,
      image_url: null,
      dietary_tags: { NON_VEG: true },
      spice_level: 5,
      customizations,
    },
    price_paid: 220 + customizations.reduce((s, c) => s + c.price_delta, 0),
    message: null,
    recipient_name: null,
    claim_token: `tok-${Math.random().toString(36).slice(2)}`,
    claim_code: "TEST12",
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  });
  const active = await sharedGiftRepo.markPaid(gift.id);
  if (!active) throw new Error("failed to activate seeded gift");
  const claimed = await sharedGiftRepo.markClaimed(gift.id, userId);
  if (!claimed) throw new Error("failed to claim seeded gift");
  return gift.id;
}

describe("POST /api/v1/orders with a gift line", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    orderRepo._reset();
    sharedGiftRepo._reset();
    sharedPaymentRepo._reset();
    resetCatalogRepository();
    app = createApp();
  });

  it("places an order with a ₹0 gift line", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);

    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    const order = res.body.data;
    expect(order.status).toBe("DRAFT");
    expect(order.items).toHaveLength(1);
    expect(order.items[0].gift_id).toBe(giftId);
    expect(order.items[0].base_price).toBe(0);
    // Gift line is free: total is packaging + GST only (Rs 10 + 18%).
    expect(order.total_amount).toBe(11.8);
  });

  it("rejects a gift_id that is not claimed by this user", async () => {
    const giftId = await seedClaimedGift(OTHER_USER_ID);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(400);

    expect(res.body.error.code).toBe("ITEM_GIFT_MISMATCH");
  });

  it("rejects a gift whose menu_item does not match the line", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID, MENU_ITEM_1);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_2,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(400);

    expect(res.body.error.code).toBe("ITEM_GIFT_MISMATCH");
  });

  it("charges the recipient nothing for gift customizations the sender already paid", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID, MENU_ITEM_1, REST_ID, [
      { name: "Extra Cheese", price_delta: 30 },
    ]);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);

    const order = res.body.data;
    expect(order.items[0].base_price).toBe(0);
    // Customization names are kept for display, but deltas are zeroed.
    expect(order.items[0].customizations).toEqual([
      { name: "Extra Cheese", price_delta: 0 },
    ]);
    expect(order.items[0].customization_total ?? 0).toBe(0);
    // Free line: packaging + GST only.
    expect(order.total_amount).toBe(11.8);
  });

  it("caps a gift line at quantity 1 server-side", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 5,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);

    const order = res.body.data;
    expect(order.items[0].quantity).toBe(1);
    expect(order.items[0].base_price).toBe(0);
    expect(order.total_amount).toBe(11.8);
  });

  it("binds the gift to the redeeming order", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);

    const bound = await sharedGiftRepo.getById(giftId);
    expect(bound?.redeemed_order_id).toBe(res.body.data.id);
    expect(bound?.status).toBe("CLAIMED");
  });

  it("rejects a second order for an already-redeemed gift (single-use)", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID);

    await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(409);

    expect(res.body.error.code).toBe("GIFT_ALREADY_REDEEMED");
  });

  it("releases a gift back to ACTIVE when the redeeming order is cancelled", async () => {
    const giftId = await seedClaimedGift(TEST_USER_ID);

    const placed = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
            gift_id: giftId,
          },
        ],
      })
      .expect(201);
    const orderId = placed.body.data.id as string;

    // Vendor cancel path unwinds the gift binding (FulfillmentService).
    const cancelRes = await request(app)
      .put(`/api/vendor/orders/${orderId}/cancel`)
      .set(authHeaders("e0000000-0000-4000-a000-000000000001", "VENDOR_OWNER"))
      .expect(200);

    expect(cancelRes.body.data.status).toBe("CANCELLED");
    const released = await sharedGiftRepo.getById(giftId);
    expect(released?.status).toBe("ACTIVE");
    expect(released?.redeemed_order_id).toBeNull();
  });
});
