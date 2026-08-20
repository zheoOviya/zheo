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

function authToken(userId = TEST_USER_ID): string {
  return jwtService.signAccessToken({
    sub: userId,
    phone: "+919876543210",
    role: "CONSUMER",
    device_fingerprint: "fp_test_device_abc1234",
  });
}

function authHeaders(userId?: string) {
  return { Authorization: `Bearer ${authToken(userId)}` };
}

/** Seeds a gift via the shared repo and marks it CLAIMED by `userId`. */
async function seedClaimedGift(
  userId: string,
  menuItemId = MENU_ITEM_1,
  restaurantId = REST_ID,
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
      customizations: [],
    },
    price_paid: 220,
    message: null,
    recipient_name: null,
    claim_token: `tok-${Math.random().toString(36).slice(2)}`,
    claim_code: "TEST12",
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  });
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
});
