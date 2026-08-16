import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { getRedis, resetRedisForTests } from "../lib/redis";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";

// ============================================
// Consumer sign-in / sign-up (phone + OTP)
// ============================================

const PHONE = "+919876500002";
const FP = "consumer-test-fp-00000001";

function consumerToken(role: string, sub = "u-consumer-00000000000001"): string {
  return jwtService.signAccessToken({
    sub,
    phone: PHONE,
    role,
    device_fingerprint: FP,
  });
}

describe("Consumer sign-in / sign-up", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  describe("POST /api/v1/auth/consumer/send-otp", () => {
    it("sends an OTP for an existing consumer", async () => {
      sharedIdentityRepo._seed({
        id: "u-consumer-00000000000001",
        phone: PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      expect(res.body.data.demoOtp).toMatch(/^[0-9]{6}$/);
      expect(res.body.data.phoneMasked).toMatch(/\*\*\*\*/);
    });

    it("auto-creates a CONSUMER and sends OTP for a new phone", async () => {
      const res = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      expect(res.body.data.demoOtp).toMatch(/^[0-9]{6}$/);

      const created = await sharedIdentityRepo.getByPhone(PHONE);
      expect(created).toBeTruthy();
      expect(created!.role).toBe("CONSUMER");
      expect(created!.is_suspended).toBe(false);
    });

    it("returns 404 for a vendor phone (no consumer auto-created)", async () => {
      sharedIdentityRepo._seed({
        id: "u-vendor-00000000000002",
        phone: PHONE,
        role: "VENDOR_OWNER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(404);
      expect(res.body.error.code).toBe("CONSUMER_NOT_FOUND");
    });

    it("rejects a suspended consumer", async () => {
      sharedIdentityRepo._seed({
        id: "u-consumer-suspended-00000001",
        phone: PHONE,
        role: "CONSUMER",
        is_suspended: true,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(403);
      expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("rejects an invalid phone number", async () => {
      const res = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: "not-a-phone" })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/auth/consumer/verify-otp", () => {
    it("verifies OTP and issues an access token + refresh cookie", async () => {
      await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      const stored = await getRedis().get(`otp:${PHONE}`);
      expect(stored).toMatch(/^[0-9]{6}$/);

      const agent = request.agent(app);
      const res = await agent
        .post("/api/v1/auth/consumer/verify-otp")
        .send({ phone: PHONE, otp: stored, device_fingerprint: FP })
        .expect(200);
      expect(res.body.data.access_token).toBeTruthy();
      expect(res.body.data.expires_in).toBe(900);
      expect(res.body.data.user.role).toBe("CONSUMER");
      expect(res.body.data.user.is_suspended).toBe(false);

      const setCookie = res.headers["set-cookie"] as string[] | undefined;
      expect(setCookie).toBeDefined();
      expect(setCookie![0]).toContain("HttpOnly");

      // The issued refresh cookie rotates into a fresh access token.
      const refresh = await agent
        .post("/api/v1/auth/refresh")
        .send({ device_fingerprint: FP })
        .expect(200);
      expect(refresh.body.data.access_token).toBeTruthy();
      expect(refresh.body.data.access_token).not.toBe(res.body.data.access_token);
    });

    it("signs up a new phone end-to-end without exceeding the rate limit", async () => {
      // Full first-time flow: send-otp auto-creates, verify-otp succeeds.
      const sendRes = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      expect(sendRes.body.data.demoOtp).toMatch(/^[0-9]{6}$/);

      const stored = await getRedis().get(`otp:${PHONE}`);
      expect(stored).toMatch(/^[0-9]{6}$/);

      const verifyRes = await request(app)
        .post("/api/v1/auth/consumer/verify-otp")
        .send({ phone: PHONE, otp: stored, device_fingerprint: FP })
        .expect(200);
      expect(verifyRes.body.data.access_token).toBeTruthy();
      expect(verifyRes.body.data.user.role).toBe("CONSUMER");
    });

    it("rejects a malformed OTP body", async () => {
      const res = await request(app)
        .post("/api/v1/auth/consumer/verify-otp")
        .send({ phone: PHONE, otp: "12", device_fingerprint: FP })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 for an unknown consumer phone", async () => {
      const res = await request(app)
        .post("/api/v1/auth/consumer/verify-otp")
        .send({ phone: PHONE, otp: "123456", device_fingerprint: FP })
        .expect(404);
      expect(res.body.error.code).toBe("CONSUMER_NOT_FOUND");
    });
  });

  describe("requireConsumerOrAdmin role gating on consumer-only routes", () => {
    it("rejects requests without a token (401)", async () => {
      await request(app).get("/api/v1/cart").expect(401);
    });

    it("forbids VENDOR_OWNER from consumer cart routes (403)", async () => {
      const res = await request(app)
        .get("/api/v1/cart")
        .set({ Authorization: `Bearer ${consumerToken("VENDOR_OWNER")}` })
        .expect(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("lets CONSUMER past the gate into the handler", async () => {
      const res = await request(app)
        .get("/api/v1/cart")
        .set({ Authorization: `Bearer ${consumerToken("CONSUMER")}` })
        .expect(200);
      expect(res.body.data.items).toEqual([]);
    });

    it("lets ADMIN past the gate into the handler", async () => {
      const res = await request(app)
        .get("/api/v1/cart")
        .set({ Authorization: `Bearer ${consumerToken("ADMIN")}` })
        .expect(200);
      expect(res.body.data.items).toEqual([]);
    });
  });
});
