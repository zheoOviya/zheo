import { describe, expect, it } from "vitest";
import {
  ApiEnvelopeSchema,
  errorEnvelope,
  successEnvelope,
} from "./envelope";

describe("API Envelope (PRD Section 4)", () => {
  it("success envelope shape is { success, data, error }", () => {
    const env = successEnvelope({ orderId: "abc" });
    expect(env).toEqual({
      success: true,
      data: { orderId: "abc" },
      error: null,
    });
    expect(ApiEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("error envelope carries code and message", () => {
    const env = errorEnvelope("OTP_LIMIT_EXCEEDED", "Max 3 OTPs per minute");
    expect(env).toEqual({
      success: false,
      data: null,
      error: {
        code: "OTP_LIMIT_EXCEEDED",
        message: "Max 3 OTPs per minute",
      },
    });
    expect(ApiEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("rejects an envelope missing error", () => {
    expect(ApiEnvelopeSchema.safeParse({ success: true, data: null }).success).toBe(
      false,
    );
  });
});
