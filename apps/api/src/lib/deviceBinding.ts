import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config";

// ============================================
// AUTH-G6 device binding.
//
// The legacy model treated a client-supplied `device_fingerprint` as an
// authentication signal. That value is generated and stored by the browser
// (localStorage) and is copied verbatim into the JWT claims, so any holder of
// a refresh token could decode the claim and replay it. This module replaces
// that with a binding the client cannot forge:
//
//   - the server generates an opaque `device_id` (non-secret) per login
//   - the server mints an httpOnly, signed `snakzap_device` cookie that
//     carries { uid, did, iat, exp } and an HMAC-SHA256 signature
//   - the JWT carries only the non-secret `device_id`
//
// Refresh requires BOTH the refresh cookie AND a valid device cookie whose
// signature, uid, did and exp all check out. The HMAC secret never leaves the
// server and is never written into a token, so decoding a refresh token is
// insufficient to rotate it.
// ============================================

export const DEVICE_COOKIE_NAME = "snakzap_device";

interface DeviceBindingPayload {
  uid: string;
  did: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", config.deviceBinding.secret)
    .update(payloadB64)
    .digest("base64url");
}

export function newDeviceId(): string {
  return randomUUID();
}

/**
 * Mints the signed binding cookie value for a (user, device) pair. The cookie
 * lives for the refresh-token lifetime so a device stays bound as long as the
 * session can be rotated.
 */
export function issueDeviceBindingCookie(
  userId: string,
  deviceId: string,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + config.jwt.refreshTtlSeconds;
  const payload: DeviceBindingPayload = { uid: userId, did: deviceId, iat, exp };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export interface DeviceBindingResult {
  ok: boolean;
  deviceId: string | null;
}

/**
 * Verifies a presented binding cookie against the expected user + device id.
 * Any failure (absent, malformed, bad signature, expired, uid/did mismatch)
 * collapses to `{ ok: false }` so callers can emit a single DEVICE_MISMATCH.
 */
export function verifyDeviceBindingCookie(
  value: string | undefined | null,
  expectedUserId: string,
  expectedDeviceId: string,
  nowMs: number = Date.now(),
): DeviceBindingResult {
  if (!value) return { ok: false, deviceId: null };

  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return { ok: false, deviceId: null };
  const payloadB64 = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expectedSignature = sign(payloadB64);
  const presented = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (presented.length !== expected.length) return { ok: false, deviceId: null };
  if (!timingSafeEqual(presented, expected)) return { ok: false, deviceId: null };

  let payload: DeviceBindingPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as DeviceBindingPayload;
  } catch {
    return { ok: false, deviceId: null };
  }

  if (
    typeof payload?.uid !== "string" ||
    typeof payload?.did !== "string" ||
    typeof payload?.iat !== "number" ||
    typeof payload?.exp !== "number" ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, deviceId: null };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (payload.exp <= nowSec) return { ok: false, deviceId: null };
  if (payload.uid !== expectedUserId) return { ok: false, deviceId: null };
  if (payload.did !== expectedDeviceId) return { ok: false, deviceId: null };

  return { ok: true, deviceId: payload.did };
}

/**
 * Cookie attributes for the binding cookie. Mirrors the existing auth-cookie
 * policy: httpOnly, Secure only in production, SameSite=Strict, Path=/, and a
 * Max-Age equal to the refresh-token lifetime.
 */
export function deviceBindingCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: config.env === "production",
    sameSite: "strict",
    path: "/",
    maxAge: config.jwt.refreshTtlSeconds * 1000,
  };
}
