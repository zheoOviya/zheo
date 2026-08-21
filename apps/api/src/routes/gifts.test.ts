import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";
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

/** Seeds an ACTIVE gift (sender is a third party) via the shared repo. */
async function seedActiveGift(): Promise<string> {
  const gift = await sharedGiftRepo.create({
    sender_id: "u00000000-0000-4000-8000-0000000000aa",
    restaurant_id: REST_ID,
    menu_item_id: MENU_ITEM_1,
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
  const active = await sharedGiftRepo.markPaid(gift.id);
  if (!active) throw new Error("failed to activate seeded gift");
  return gift.id;
}

async function claimTokenForGiftId(giftId: string): Promise<string> {
  return (await sharedGiftRepo.getById(giftId))!.claim_token;
}

describe("Gift routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedGiftRepo._reset();
    sharedPaymentRepo._reset();
    resetCatalogRepository();
    app = createApp();
  });

  describe("POST /api/v1/gifts", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app)
        .post("/api/v1/gifts")
        .set("Content-Type", "application/json")
        .send({});
      expect(res.status).toBe(401);
    });

    it("creates a gift with a pending payment", async () => {
      const res = await request(app)
        .post("/api/v1/gifts")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          menu_item_id: MENU_ITEM_1,
          customizations: [{ name: "Extra Cheese", price_delta: 30 }],
          message: "Enjoy!",
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.gift.status).toBe("PENDING");
      expect(res.body.data.gift.price_paid).toBe(250);
      expect(res.body.data.razorpay_order_id).toMatch(/^order_mock_/);
    });

    it("returns the same Razorpay order on pay retries (idempotent)", async () => {
      const create = await request(app)
        .post("/api/v1/gifts")
        .set(authHeaders())
        .send({ restaurant_id: REST_ID, menu_item_id: MENU_ITEM_1 })
        .expect(201);
      const giftId = create.body.data.gift.id as string;

      const first = await request(app)
        .post(`/api/v1/gifts/${giftId}/pay`)
        .set(authHeaders())
        .expect(200);
      const retry = await request(app)
        .post(`/api/v1/gifts/${giftId}/pay`)
        .set(authHeaders())
        .expect(200);

      expect(first.body.data.razorpay_order_id).toBe(
        retry.body.data.razorpay_order_id,
      );
    });

    it("cancels a PENDING gift", async () => {
      const create = await request(app)
        .post("/api/v1/gifts")
        .set(authHeaders())
        .send({ restaurant_id: REST_ID, menu_item_id: MENU_ITEM_1 })
        .expect(201);
      const giftId = create.body.data.gift.id as string;

      const res = await request(app)
        .post(`/api/v1/gifts/${giftId}/cancel`)
        .set(authHeaders())
        .expect(200);

      expect(res.body.data.status).toBe("CANCELLED");
    });

    it("refunds a paid ACTIVE gift on sender cancel (mock env resolves immediately)", async () => {
      const gift = await sharedGiftRepo.create({
        sender_id: TEST_USER_ID,
        restaurant_id: REST_ID,
        menu_item_id: MENU_ITEM_1,
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
        claim_code: "TSTREF",
        expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      });
      const active = await sharedGiftRepo.markPaid(gift.id);
      if (!active) throw new Error("failed to activate gift");
      const payment = await sharedPaymentRepo.create({
        gift_id: gift.id,
        razorpay_order_id: "order_mock_refund",
        amount: 220,
      });
      await sharedPaymentRepo.updateWebhookResult(payment.id, {
        razorpay_payment_id: "pay_mock_refund",
        status: "CAPTURED",
        method: "upi",
        webhook_event: "payment.captured",
        webhook_raw: null,
      });

      const res = await request(app)
        .post(`/api/v1/gifts/${gift.id}/cancel`)
        .set(authHeaders())
        .expect(200);

      expect(res.body.data.status).toBe("REFUNDED");
      expect(res.body.data.refunded_at).not.toBeNull();
    });
  });

  describe("GET /api/v1/gifts/t/:token", () => {
    it("returns 404 for an unknown token", async () => {
      const res = await request(app).get("/api/v1/gifts/t/nope");
      expect(res.status).toBe(404);
    });

    it("masks the sender on the landing page", async () => {
      const giftId = await seedActiveGift();
      const token = await claimTokenForGiftId(giftId);
      const res = await request(app).get(`/api/v1/gifts/t/${token}`).expect(200);
      expect(res.body.data.sender_display).toBe("Your friend");
      expect(res.body.data.claimable).toBe(true);
    });
  });

  describe("POST /api/v1/gifts/t/:token/claim", () => {
    it("claims once and rejects a second claim cleanly", async () => {
      const giftId = await seedActiveGift();
      const token = await claimTokenForGiftId(giftId);

      const first = await request(app)
        .post(`/api/v1/gifts/t/${token}/claim`)
        .set(authHeaders(OTHER_USER_ID))
        .expect(200);
      expect(first.body.data.status).toBe("CLAIMED");
      expect(first.body.data.claimed_by).toBe(OTHER_USER_ID);

      // A sequential duplicate claim is rejected with a clean 4xx, not a 500.
      const second = await request(app)
        .post(`/api/v1/gifts/t/${token}/claim`)
        .set(authHeaders(OTHER_USER_ID))
        .expect(400);
      expect(second.body.error.code).toBe("GIFT_NOT_CLAIMABLE");
    });

    it("releases a claimed gift back to ACTIVE", async () => {
      const giftId = await seedActiveGift();
      const token = await claimTokenForGiftId(giftId);

      await request(app)
        .post(`/api/v1/gifts/t/${token}/claim`)
        .set(authHeaders(OTHER_USER_ID))
        .expect(200);

      const res = await request(app)
        .post(`/api/v1/gifts/t/${token}/release`)
        .set(authHeaders(OTHER_USER_ID))
        .expect(200);
      expect(res.body.data.status).toBe("ACTIVE");
      expect(res.body.data.claimed_by).toBeNull();
    });
  });
});
