import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { getRedis, resetRedisForTests } from "../lib/redis";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";

// ============================================
// Vendor sign-in / sign-up (phone + OTP)
// ============================================

const PHONE = "+919876500001";
const FP = "vendor-test-fp-00000001";

function vendorToken(role: string, sub = "u-vendor-00000000000001"): string {
  return jwtService.signAccessToken({
    sub,
    phone: PHONE,
    role,
    device_fingerprint: FP,
  });
}

describe("Vendor sign-in / sign-up", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  describe("POST /api/v1/auth/vendor/signup", () => {
    it("creates a PENDING_VENDOR account", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.role).toBe("PENDING_VENDOR");
      expect(res.body.data.phone).toBe(PHONE);
    });

    it("rejects a duplicate phone with 409", async () => {
      await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(201);
      const res = await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(409);
      expect(res.body.error.code).toBe("PHONE_TAKEN");
    });

    it("rejects a phone already used by a consumer", async () => {
      sharedIdentityRepo._seed({
        id: "u-consumer-00000000000001",
        phone: PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(409);
      expect(res.body.error.code).toBe("PHONE_TAKEN");
    });

    it("rejects an invalid phone number", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: "not-a-phone" })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/auth/vendor/send-otp", () => {
    it("sends an OTP for an existing vendor", async () => {
      await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(201);
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      expect(res.body.data.demoOtp).toMatch(/^[0-9]{6}$/);
      expect(res.body.data.phoneMasked).toMatch(/\*\*\*\*/);
    });

    it("returns 404 for an unknown phone", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: PHONE })
        .expect(404);
      expect(res.body.error.code).toBe("VENDOR_NOT_FOUND");
    });

    it("returns 404 for a consumer phone", async () => {
      sharedIdentityRepo._seed({
        id: "u-consumer-00000000000002",
        phone: PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: PHONE })
        .expect(404);
      expect(res.body.error.code).toBe("VENDOR_NOT_FOUND");
    });

    it("rejects a suspended vendor", async () => {
      sharedIdentityRepo._seed({
        id: "u-vendor-suspended-00000001",
        phone: PHONE,
        role: "VENDOR_OWNER",
        is_suspended: true,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: PHONE })
        .expect(403);
      expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    });
  });

  describe("POST /api/v1/auth/vendor/verify-otp", () => {
    it("verifies OTP and issues an access token + refresh cookie", async () => {
      await request(app)
        .post("/api/v1/auth/vendor/signup")
        .send({ phone: PHONE })
        .expect(201);
      await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: PHONE })
        .expect(200);
      const stored = await getRedis().get(`otp:${PHONE}`);
      expect(stored).toMatch(/^[0-9]{6}$/);

      const agent = request.agent(app);
      const res = await agent
        .post("/api/v1/auth/vendor/verify-otp")
        .send({ phone: PHONE, otp: stored, device_fingerprint: FP })
        .expect(200);
      expect(res.body.data.access_token).toBeTruthy();
      expect(res.body.data.expires_in).toBe(900);
      expect(res.body.data.user.role).toBe("PENDING_VENDOR");

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

    it("rejects a malformed OTP body", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/verify-otp")
        .send({ phone: PHONE, otp: "12", device_fingerprint: FP })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 for an unknown vendor phone", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/verify-otp")
        .send({ phone: PHONE, otp: "123456", device_fingerprint: FP })
        .expect(404);
      expect(res.body.error.code).toBe("VENDOR_NOT_FOUND");
    });
  });

  describe("requireVendorAuth role gating on /api/vendor", () => {
    it("rejects requests without a token (401)", async () => {
      await request(app).get("/api/vendor/orders").expect(401);
    });

    it("forbids PENDING_VENDOR from vendor routes (403)", async () => {
      const res = await request(app)
        .get("/api/vendor/orders")
        .set({ Authorization: `Bearer ${vendorToken("PENDING_VENDOR")}` })
        .expect(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("forbids CONSUMER from vendor routes (403)", async () => {
      await request(app)
        .get("/api/vendor/orders")
        .set({ Authorization: `Bearer ${vendorToken("CONSUMER")}` })
        .expect(403);
    });

    it("lets VENDOR_OWNER past the gate into the handler", async () => {
      const res = await request(app)
        .get("/api/vendor/orders")
        .set({ Authorization: `Bearer ${vendorToken("VENDOR_OWNER")}` })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("lets VENDOR_STAFF past the gate into the handler", async () => {
      const res = await request(app)
        .get("/api/vendor/orders")
        .set({ Authorization: `Bearer ${vendorToken("VENDOR_STAFF")}` })
        .expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
