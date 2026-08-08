import { describe, expect, it } from "vitest";
import {
  PICKUP_OTP_LENGTH,
  isPickupOtpComplete,
  pickupFailureMessage,
  sanitizePickupOtp,
} from "../kds";

describe("kds pickup-OTP helpers", () => {
  it("defines a 4-digit pickup code length", () => {
    expect(PICKUP_OTP_LENGTH).toBe(4);
  });

  it("sanitizes input to digits only, capped at 4", () => {
    expect(sanitizePickupOtp("12ab")).toBe("12");
    expect(sanitizePickupOtp("12-34")).toBe("1234");
    expect(sanitizePickupOtp("12345678")).toBe("1234");
    expect(sanitizePickupOtp("")).toBe("");
  });

  it("only considers a complete 4-digit code ready to hand over", () => {
    expect(isPickupOtpComplete(undefined)).toBe(false);
    expect(isPickupOtpComplete("")).toBe(false);
    expect(isPickupOtpComplete("123")).toBe(false);
    expect(isPickupOtpComplete("1234")).toBe(true);
  });

  it("maps INVALID_OTP to a retry-friendly message", () => {
    expect(pickupFailureMessage("INVALID_OTP")).toContain("Invalid or expired");
    expect(pickupFailureMessage("INVALID_OTP")).toContain("try again");
  });

  it("maps ALREADY_PICKED_UP and NOT_READY states", () => {
    expect(pickupFailureMessage("ALREADY_PICKED_UP")).toContain("already handed over");
    expect(pickupFailureMessage("NOT_READY")).toContain("not ready for pickup");
  });

  it("falls back to the server message, then a generic message", () => {
    expect(pickupFailureMessage("SOMETHING_ELSE", "Server said no")).toBe("Server said no");
    expect(pickupFailureMessage(undefined)).toContain("Could not hand over");
  });
});
