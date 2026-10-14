import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import {
  DEVICE_COOKIE_NAME,
  deviceBindingCookieOptions,
  issueDeviceBindingCookie,
  newDeviceId,
  verifyDeviceBindingCookie,
} from "./deviceBinding";

const USER = "u-device-binding-000000000001";
const OTHER_USER = "u-device-binding-000000000002";

describe("AUTH-G6 device binding cookie", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("mints a device id server-side", () => {
    const a = newDeviceId();
    const b = newDeviceId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("round-trips a valid binding for the same user and device", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId);
    const result = verifyDeviceBindingCookie(value, USER, deviceId);
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe(deviceId);
  });

  it("rejects a missing cookie", () => {
    expect(verifyDeviceBindingCookie(undefined, USER, "did").ok).toBe(false);
    expect(verifyDeviceBindingCookie("", USER, "did").ok).toBe(false);
    expect(verifyDeviceBindingCookie(null, USER, "did").ok).toBe(false);
  });

  it("rejects a forged signature", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId);
    const [payload] = value.split(".");
    const forged = `${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const result = verifyDeviceBindingCookie(forged, USER, deviceId);
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered payload without a matching signature", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId);
    const [, signature] = value.split(".");
    const hackedPayload = Buffer.from(
      JSON.stringify({ uid: USER, did: deviceId, iat: 1, exp: 9_999_999_999 }),
    ).toString("base64url");
    const result = verifyDeviceBindingCookie(
      `${hackedPayload}.${signature}`,
      USER,
      deviceId,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a uid mismatch", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId);
    expect(verifyDeviceBindingCookie(value, OTHER_USER, deviceId).ok).toBe(false);
  });

  it("rejects a device id mismatch", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId);
    expect(
      verifyDeviceBindingCookie(value, USER, newDeviceId()).ok,
    ).toBe(false);
  });

  it("rejects an expired binding", () => {
    const deviceId = newDeviceId();
    const value = issueDeviceBindingCookie(USER, deviceId, 0);
    const afterTtl = (config.jwt.refreshTtlSeconds + 10) * 1000;
    expect(verifyDeviceBindingCookie(value, USER, deviceId, afterTtl).ok).toBe(false);
  });

  it("rejects a malformed cookie (no separator)", () => {
    expect(verifyDeviceBindingCookie("not-a-cookie", USER, "did").ok).toBe(false);
  });

  it("uses a dedicated cookie name and the required attributes", () => {
    expect(DEVICE_COOKIE_NAME).toBe("snakzap_device");
    const opts = deviceBindingCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("strict");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(config.jwt.refreshTtlSeconds * 1000);
    // Secure is bound to production (false under the test env).
    expect(opts.secure).toBe(config.env === "production");
  });

  it("sets Secure in production", async () => {
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const mod = await import("./deviceBinding");
      expect(mod.deviceBindingCookieOptions().secure).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
      vi.resetModules();
    }
  });

  it("never embeds the binding secret in an issued JWT", async () => {
    const { jwtService } = await import("../services/jwt");
    const device_id = newDeviceId();
    const { token } = jwtService.signRefreshToken({
      sub: USER,
      phone: "+919876000000",
      role: "CONSUMER",
      device_fingerprint: "fp-test-000000000000",
      device_id,
    });
    const secret = config.deviceBinding.secret;
    expect(secret.length).toBeGreaterThan(0);
    expect(token).not.toContain(secret);
    // The non-secret device_id claim survives the round trip.
    const decoded = jwtService.verifyRefreshToken(token);
    expect(decoded.device_id).toBe(device_id);
  });
});
