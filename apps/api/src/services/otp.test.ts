import { beforeEach, describe, expect, it } from "vitest";
import { resetRedisForTests } from "../lib/redis";
import { AppError } from "../middleware/envelope";
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

  it("rejects an invalid OTP", async () => {
    await sendOtp("+919876543210");
    await expect(verifyOtp("+919876543210", "000000")).rejects.toBeInstanceOf(AppError);
  });

  it("rejects verification when no OTP was requested", async () => {
    await expect(verifyOtp("+919999999999", "123456")).rejects.toMatchObject({
      code: "OTP_EXPIRED",
    });
  });

  it("consumes the OTP after successful verification", async () => {
    await sendOtp("+919876543210");
    const { getRedis } = await import("../lib/redis");
    const stored = await getRedis().get("otp:+919876543210");
    await verifyOtp("+919876543210", stored as string);
    expect(await getRedis().get("otp:+919876543210")).toBeNull();
  });
});
