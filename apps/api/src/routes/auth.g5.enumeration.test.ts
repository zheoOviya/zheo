import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { getRedis, resetRedisForTests } from "../lib/redis";
import { sharedIdentityRepo } from "../repositories/shared";

const ADMIN_EMAIL = "ops@snakzap.dev";
const ADMIN_PHONE = "+919876000060";
const ADMIN_ID = "u-admin-email-000000000001";
const UNKNOWN_ADMIN_EMAIL = "nobody@snakzap.dev";
const CONSUMER_EMAIL = "buyer@snakzap.dev";
const VENDOR_PHONE = "+919876500001";
const UNKNOWN_VENDOR_PHONE = "+919876500099";
const CONSUMER_AS_VENDOR_PHONE = "+919876500088";
const NEW_CONSUMER_PHONE = "+919876500077";
const FP = "g5-enum-fp-00000001";

function sendOtpShape(body: { success: boolean; data: unknown; error: unknown }) {
  expect(body.success).toBe(true);
  expect(body.error).toBeNull();
  const data = body.data as {
    sent: boolean;
    phoneMasked: string;
    expiresInSeconds: number;
    demoOtp?: string;
  };
  expect(data.sent).toBe(true);
  expect(data.phoneMasked).toMatch(/\*\*\*\*/);
  expect(data.expiresInSeconds).toEqual(expect.any(Number));
  return data;
}

describe("AUTH-G5 send-otp enumeration hardening", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  describe("ENUM-ADMIN", () => {
    beforeEach(() => {
      sharedIdentityRepo._seed({
        id: ADMIN_ID,
        phone: ADMIN_PHONE,
        email: ADMIN_EMAIL,
        role: "ADMIN",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      sharedIdentityRepo._seed({
        id: "u-consumer-email-00000001",
        phone: "+919876000062",
        email: CONSUMER_EMAIL,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
    });

    it("existing and absent operator emails return the same send-otp status and shape", async () => {
      const existing = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email: ADMIN_EMAIL })
        .expect(200);
      const unknown = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email: UNKNOWN_ADMIN_EMAIL })
        .expect(200);
      const consumer = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email: CONSUMER_EMAIL })
        .expect(200);

      const existingData = sendOtpShape(existing.body);
      const unknownData = sendOtpShape(unknown.body);
      const consumerData = sendOtpShape(consumer.body);
      expect(Object.keys(existingData).sort()).toEqual(Object.keys(unknownData).sort());
      expect(Object.keys(existingData).sort()).toEqual(Object.keys(consumerData).sort());
    });

    it("unknown operator probe creates no user, cookie, or token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email: UNKNOWN_ADMIN_EMAIL })
        .expect(200);
      sendOtpShape(res.body);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.data.access_token).toBeUndefined();
      expect(res.body.data.user).toBeUndefined();
      expect(await sharedIdentityRepo.getByEmail(UNKNOWN_ADMIN_EMAIL)).toBeNull();
    });

    it("demo OTP from an unknown operator probe cannot authenticate", async () => {
      const res = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email: UNKNOWN_ADMIN_EMAIL })
        .expect(200);
      const demoOtp = res.body.data.demoOtp as string | undefined;
      expect(demoOtp).toMatch(/^[0-9]{6}$/);

      const verify = await request(app)
        .post("/api/v1/auth/admin/verify-otp")
        .send({
          email: UNKNOWN_ADMIN_EMAIL,
          otp: demoOtp,
          device_fingerprint: FP,
        });
      expect(verify.status).not.toBe(200);
      expect(verify.body.success).toBe(false);
      expect(verify.body.data).toBeNull();
      expect(verify.headers["set-cookie"]).toBeUndefined();
      expect(verify.body.data?.access_token).toBeUndefined();
      expect(await sharedIdentityRepo.getByEmail(UNKNOWN_ADMIN_EMAIL)).toBeNull();
    });
  });

  describe("ENUM-VENDOR", () => {
    beforeEach(() => {
      sharedIdentityRepo._seed({
        id: "u-vendor-g5-00000000000001",
        phone: VENDOR_PHONE,
        role: "VENDOR_OWNER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
      sharedIdentityRepo._seed({
        id: "u-consumer-g5-00000000000001",
        phone: CONSUMER_AS_VENDOR_PHONE,
        role: "CONSUMER",
        is_suspended: false,
        totp_enabled: false,
        created_at: new Date().toISOString(),
      });
    });

    it("existing and absent vendor phones return the same send-otp status and shape", async () => {
      const existing = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: VENDOR_PHONE })
        .expect(200);
      const unknown = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: UNKNOWN_VENDOR_PHONE })
        .expect(200);
      const consumer = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: CONSUMER_AS_VENDOR_PHONE })
        .expect(200);

      const existingData = sendOtpShape(existing.body);
      const unknownData = sendOtpShape(unknown.body);
      const consumerData = sendOtpShape(consumer.body);
      expect(Object.keys(existingData).sort()).toEqual(Object.keys(unknownData).sort());
      expect(Object.keys(existingData).sort()).toEqual(Object.keys(consumerData).sort());
    });

    it("unknown vendor probe creates no vendor user, cookie, or token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: UNKNOWN_VENDOR_PHONE })
        .expect(200);
      sendOtpShape(res.body);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body.data.access_token).toBeUndefined();
      expect(res.body.data.user).toBeUndefined();
      expect(await sharedIdentityRepo.getByPhone(UNKNOWN_VENDOR_PHONE)).toBeNull();
    });

    it("demo OTP from an unknown vendor probe cannot authenticate", async () => {
      const res = await request(app)
        .post("/api/v1/auth/vendor/send-otp")
        .send({ phone: UNKNOWN_VENDOR_PHONE })
        .expect(200);
      const demoOtp = res.body.data.demoOtp as string | undefined;
      expect(demoOtp).toMatch(/^[0-9]{6}$/);

      const verify = await request(app)
        .post("/api/v1/auth/vendor/verify-otp")
        .send({
          phone: UNKNOWN_VENDOR_PHONE,
          otp: demoOtp,
          device_fingerprint: FP,
        });
      expect(verify.status).not.toBe(200);
      expect(verify.body.success).toBe(false);
      expect(verify.headers["set-cookie"]).toBeUndefined();
      expect(await sharedIdentityRepo.getByPhone(UNKNOWN_VENDOR_PHONE)).toBeNull();
    });
  });

  describe("CONSUMER_AUTH_REGRESSION", () => {
    it("still auto-creates a CONSUMER and completes verify for a new phone", async () => {
      const send = await request(app)
        .post("/api/v1/auth/consumer/send-otp")
        .send({ phone: NEW_CONSUMER_PHONE })
        .expect(200);
      sendOtpShape(send.body);

      const created = await sharedIdentityRepo.getByPhone(NEW_CONSUMER_PHONE);
      expect(created).toBeTruthy();
      expect(created!.role).toBe("CONSUMER");

      const stored = await getRedis().get(`otp:${NEW_CONSUMER_PHONE}`);
      expect(stored).toMatch(/^[0-9]{6}$/);

      const verify = await request(app)
        .post("/api/v1/auth/consumer/verify-otp")
        .send({
          phone: NEW_CONSUMER_PHONE,
          otp: stored,
          device_fingerprint: FP,
        })
        .expect(200);
      expect(verify.body.data.access_token).toBeTruthy();
      expect(verify.body.data.user.role).toBe("CONSUMER");
    });
  });
});
