import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";
import { getRedis, resetRedisForTests } from "../lib/redis";

const PHONE = "+919876543210";
const FP_A = "fp-device-a-1234567890";
const FP_B = "fp-device-b-1234567890";

describe("Auth routes (integration)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  async function requestOtp(phone: string) {
    const res = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone })
      .expect(200);
    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data.phoneMasked).toMatch(/\*\*\*\*/);
  }

  async function readStoredOtp(phone: string): Promise<string> {
    const redis = getRedis();
    const stored = await redis.get(`otp:${phone}`);
    expect(stored).toMatch(/^[0-9]{6}$/);
    return stored as string;
  }

  it("send-otp -> verify-otp -> refresh -> logout flow", async () => {
    await requestOtp(PHONE);
    const otp = await readStoredOtp(PHONE);

    const agent = request.agent(app);
    const verifyRes = await agent
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp, device_fingerprint: FP_A })
      .expect(200);

    expect(ApiEnvelopeSchema.safeParse(verifyRes.body).success).toBe(true);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data.access_token).toBeTruthy();
    expect(verifyRes.body.data.expires_in).toBe(900);
    expect(verifyRes.body.data.user.role).toBe("CONSUMER");

    const setCookie = verifyRes.headers["set-cookie"] as string[] | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie![0]).toContain("HttpOnly");
    const firstCookie = setCookie![0]!;

    const refreshRes = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(200);

    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.data.access_token).toBeTruthy();
    expect(refreshRes.body.data.access_token).not.toBe(verifyRes.body.data.access_token);

    // Old refresh token is now blacklisted -> reuse on a fresh agent must fail
    const reused = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", firstCookie)
      .send({ device_fingerprint: FP_A });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // Refresh again with the rotated cookie works
    const refresh2 = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(200);
    expect(refresh2.body.data.access_token).toBeTruthy();
  });

  it("rejects refresh on device mismatch (step-up auth required)", async () => {
    await requestOtp(PHONE);
    const otp = await readStoredOtp(PHONE);

    const agent = request.agent(app);
    await agent
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp, device_fingerprint: FP_A })
      .expect(200);

    const res = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_B })
      .expect(401);
    expect(res.body.error.code).toBe("DEVICE_MISMATCH");
  });

  it("rejects refresh without a refresh cookie", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(401);
    expect(res.body.error.code).toBe("REFRESH_TOKEN_MISSING");
  });

  it("validates request bodies with Zod", async () => {
    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: "not-a-phone", otp: "12", device_fingerprint: "x" })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces OTP rate limit of 3 per minute per phone", async () => {
    for (let i = 0; i < 3; i++) {
      await requestOtp(PHONE);
    }
    const blocked = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone: PHONE })
      .expect(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
