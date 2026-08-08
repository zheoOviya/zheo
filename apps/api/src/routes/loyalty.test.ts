import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedAuditRepo,
  sharedLoyaltyRepo,
  sharedOrderRepo,
} from "../repositories/shared";

// ============================================
// Loyalty routes (L05 Refer & Earn + L01 Stamp Card) end-to-end
// P04 Traffic ETA route
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";
const REFERRER_ID = "00000000-0000-4000-8000-0000000000a1";
const CLAIMANT_A = "00000000-0000-4000-8000-0000000000b1";
const CLAIMANT_B = "00000000-0000-4000-8000-0000000000b2";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

function auth(userId: string, deviceFp = "fp_test_device_abc1234") {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: deviceFp,
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

describe("Loyalty routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    sharedAuditRepo._reset();
    sharedLoyaltyRepo._reset();
    app = createApp();
  });

  describe("GET /api/v1/loyalty/referral", () => {
    it("returns a stable code and the Rs 50 offer", async () => {
      const res = await request(app)
        .get("/api/v1/loyalty/referral")
        .set(auth(CLAIMANT_A))
        .expect(200);

      expect(res.body.data.referral_code).toMatch(/^SNKZ-[A-Z0-9]{6}$/);
      expect(res.body.data.bonus_amount).toBe(50);
      expect(res.body.data.balance).toBe(0);

      const again = await request(app)
        .get("/api/v1/loyalty/referral")
        .set(auth(CLAIMANT_A))
        .expect(200);
      expect(again.body.data.referral_code).toBe(res.body.data.referral_code);
    });

    it("requires authentication", async () => {
      const res = await request(app)
        .get("/api/v1/loyalty/referral")
        .expect(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("POST /api/v1/loyalty/apply-referral", () => {
    it("credits Rs 50 when the code is valid", async () => {
      await sharedLoyaltyRepo.getReferralCode(REFERRER_ID); // establish the referrer code

      const res = await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_A))
        .set("x-forwarded-for", "203.0.113.5")
        .set("x-device-fingerprint", "fp_route_a")
        .send({ referral_code: (await sharedLoyaltyRepo.getReferralCode(REFERRER_ID)) })
        .expect(201);

      expect(res.body.data.claimed).toBe(true);
      expect(res.body.data.bonus_amount).toBe(50);
      expect(res.body.data.balance).toBe(50);

      const audits = await sharedAuditRepo.all();
      expect(audits.some((a) => a.action === "referral_applied")).toBe(true);
    });

    it("rejects an unknown code", async () => {
      const res = await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_A))
        .send({ referral_code: "SNKZ-XXXX99" })
        .expect(400);
      expect(res.body.error.code).toBe("INVALID_REFERRAL_CODE");
    });

    it("FRAUD: claiming twice from the same IP returns 403 FRAUD_DETECTED", async () => {
      const code = await sharedLoyaltyRepo.getReferralCode(REFERRER_ID);

      const first = await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_A))
        .set("x-forwarded-for", "198.51.100.42")
        .set("x-device-fingerprint", "fp_route_a")
        .send({ referral_code: code })
        .expect(201);
      expect(first.body.data.balance).toBe(50);

      // Different account, same network IP -> blocked before any credit.
      const second = await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_B))
        .set("x-forwarded-for", "198.51.100.42")
        .set("x-device-fingerprint", "fp_route_b")
        .send({ referral_code: code })
        .expect(403);

      expect(second.body.error.code).toBe("FRAUD_DETECTED");

      const audits = await sharedAuditRepo.all();
      const blocked = audits.find((a) => a.action === "referral_fraud_blocked");
      expect(blocked?.metadata).toMatchObject({ dimension: "ip" });
    });

    it("FRAUD: claiming twice from the same device returns 403 FRAUD_DETECTED", async () => {
      const code = await sharedLoyaltyRepo.getReferralCode(REFERRER_ID);

      await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_A))
        .set("x-forwarded-for", "203.0.113.50")
        .set("x-device-fingerprint", "fp_shared")
        .send({ referral_code: code })
        .expect(201);

      const second = await request(app)
        .post("/api/v1/loyalty/apply-referral")
        .set(auth(CLAIMANT_B))
        .set("x-forwarded-for", "203.0.113.51")
        .set("x-device-fingerprint", "fp_shared")
        .send({ referral_code: code })
        .expect(403);

      expect(second.body.error.code).toBe("FRAUD_DETECTED");

      const audits = await sharedAuditRepo.all();
      const blocked = audits.find((a) => a.action === "referral_fraud_blocked");
      expect(blocked?.metadata).toMatchObject({ dimension: "device" });
    });
  });

  describe("L01 Stamp Card end-to-end", () => {
    it("fills a stamp when an order is picked up", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(auth(CLAIMANT_A))
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

      const ready = await sharedOrderRepo.getById(orderId);
      await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(auth(CLAIMANT_A))
        .send({ pickup_otp: ready?.pickup_otp })
        .expect(200);

      const cards = await request(app)
        .get("/api/v1/loyalty/stamp-cards")
        .set(auth(CLAIMANT_A))
        .expect(200);

      expect(cards.body.data).toHaveLength(1);
      expect(cards.body.data[0]).toMatchObject({
        restaurant_id: REST_ID,
        stamp_count: 1,
        total_orders: 1,
        reward_type: "FREE_ITEM",
      });
    });
  });

  describe("GET /api/v1/eta (P04)", () => {
    it("returns a traffic-aware mock ETA", async () => {
      const res = await request(app)
        .get(
          "/api/v1/eta?origin_lat=19.076&origin_lng=72.8777&destination_lat=19.1136&destination_lng=72.8697",
        )
        .expect(200);

      expect(res.body.data.source).toBe("mock");
      expect(res.body.data.eta_seconds).toBeGreaterThan(0);
      expect(res.body.data.duration_text).toMatch(/^\d+ mins$/);
      expect(res.body.data.distance_km).toBeGreaterThan(0);
    });

    it("validates coordinates", async () => {
      const res = await request(app)
        .get("/api/v1/eta?origin_lat=999&origin_lng=0&destination_lat=0&destination_lng=0")
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
