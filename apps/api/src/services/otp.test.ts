import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRedis, resetRedisForTests, setRedisForTests } from "../lib/redis";
import { maskPhone, sendOtp, verifyOtp } from "./otp";

describe("OTP service", () => {
  beforeEach(() => {
    resetRedisForTests();
  });

  it("masks phone numbers for logging", () => {
    expect(maskPhone("+919876543210")).toBe("+9****10");
  });

  it("stores and verifies a 6-digit OTP", async () => {
    const { phoneMasked, sent } = await sendOtp("+919876543210");
    expect(sent).toBe(true);
    expect(phoneMasked).toBe("+9****10");

    // OTP is retrievable from Redis store, so verify against a captured value.
    // sendOtp generates randomly; to verify end-to-end we read the stored value
    // through the same Redis seam used by verifyOtp.
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    expect(stored).toMatch(/^[0-9]{6}$/);

    const result = await verifyOtp("+919876543210", stored as string);
    expect(result.valid).toBe(true);
  });

  it("rejects an invalid OTP in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const mem = new MemoryRedis();
    setRedisForTests(mem);
    try {
      // Seed the OTP directly to avoid an SMS dispatch in production mode.
      await mem.set("otp:+919876543210", "123456", "PX", 300_000);
      await expect(verifyOtp("+919876543210", "000000")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("rejects verification in production when no OTP was requested", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    setRedisForTests(new MemoryRedis());
    try {
      await expect(verifyOtp("+919999999999", "123456")).rejects.toMatchObject({
        code: "OTP_EXPIRED",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("accepts the on-screen code when the stored OTP is missing (demo resilience)", async () => {
    // No OTP was sent -> no Redis entry. In non-production demo builds the
    // stateless fallback lets the on-screen 6-digit code complete login
    // (e.g. after a dev-server restart wiped the in-memory store).
    const result = await verifyOtp("+919888888888", "123456");
    expect(result.valid).toBe(true);

    // Malformed codes still fail.
    await expect(verifyOtp("+919888888888", "12345")).rejects.toMatchObject({
      code: "OTP_INVALID",
    });
  });

  it("consumes the OTP after successful verification", async () => {
    await sendOtp("+919876543210");
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    await verifyOtp("+919876543210", stored as string);
    expect(await getRedis().get("otp:+919876543210")).toBeNull();
  });

  it("exposes the generated OTP on-screen in non-production demo builds", async () => {
    const { demoOtp } = await sendOtp("+919876543210");
    expect(demoOtp).toMatch(/^[0-9]{6}$/);

    // The on-screen code is the REAL OTP (matches Redis, verifies end-to-end).
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    expect(stored).toBe(demoOtp);
    const result = await verifyOtp("+919876543210", demoOtp as string);
    expect(result.valid).toBe(true);
  });

  it("does NOT honour DEV_BYPASS_OTP in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevBypass = process.env.DEV_BYPASS_OTP;
    process.env.NODE_ENV = "production";
    process.env.DEV_BYPASS_OTP = "true";
    // Pin a memory client so flipping NODE_ENV does not construct a real ioredis.
    setRedisForTests(new MemoryRedis());
    try {
      const sent = await sendOtp("+919876543210");
      // On-screen OTP must never be exposed in production.
      expect(sent.demoOtp).toBeUndefined();
      await expect(verifyOtp("+919876543210", "000001")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      process.env.DEV_BYPASS_OTP = prevBypass;
    }
  });

  it("accepts any 6-digit code in non-production (automatic dev login)", async () => {
    // In development/preview builds the OTP is shown on-screen automatically
    // and any well-formed 6-digit code completes login, so the demo can never
    // fail with "Invalid OTP" — even with no code requested, no DEV_BYPASS_OTP,
    // or a stale browser bundle.
    const result = await verifyOtp("+919876543210", "123456");
    expect(result.valid).toBe(true);
  });
});
