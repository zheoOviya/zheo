import { randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { getRedis } from "../lib/redis";
import { AppError } from "../middleware/envelope";

// ============================================
// MSG91 OTP (PRD Phase 1, identity context)
// OTP stored in Redis with 5 min TTL.
// Actual SMS dispatch via MSG91 API is simulated behind
// a `sendSms` seam so tests run offline (ECS resilience).
// ============================================

const OTP_PREFIX = "otp:";
const OTP_ATTEMPTS_PREFIX = "otp:attempts:";
const OTP_MAX_VERIFY_ATTEMPTS = 5;

function otpKey(phone: string): string {
  return `${OTP_PREFIX}${phone}`;
}

function attemptsKey(phone: string): string {
  return `${OTP_ATTEMPTS_PREFIX}${phone}`;
}

function otpTtlMs(): number {
  return config.msg91.otpTtlSeconds * 1000;
}

function redisUnavailable(): never {
  throw new AppError(
    "SERVICE_UNAVAILABLE",
    "OTP service temporarily unavailable",
    503,
  );
}

// The dev/preview auth bypass (on-screen demo OTP + any-6-digit verify) is
// ONLY active when explicitly opted in via ALLOW_DEV_AUTH_BYPASS=true, or in
// the test environment. This replaces the previous `NODE_ENV !== "production"`
// check, which silently enabled the bypass in any misconfigured staging
// environment (empty or "staging" NODE_ENV). NODE_ENV is read at call time so
// the test suite can still flip it to "production" and assert strict behavior.
function isDevBypassActive(): boolean {
  if (config.auth.allowDevAuthBypass) return true;
  return process.env.NODE_ENV === "test";
}

export interface SendOtpResult {
  sent: boolean;
  phoneMasked: string;
  expiresInSeconds: number;
  /** On-screen OTP surfaced for demo/preview builds. Never present in production. */
  demoOtp?: string;
}

export function maskPhone(phone: string): string {
  if (phone.length < 6) return "****";
  return `${phone.slice(0, 2)}****${phone.slice(-2)}`;
}

/**
 * Canonicalizes a phone number to E.164 (+91XXXXXXXXXX for Indian mobiles).
 * Users commonly enter the 10-digit number without the country code, which
 * would otherwise be stored as a distinct (and orphaned) account from the
 * canonical +91-prefixed seed/demo records. Normalizing before lookup and
 * storage makes "9876000102" resolve to "+919876000102".
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return input;
}

export async function sendSms(
  phone: string,
  otp: string,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;

  // In dev/preview builds with the on-screen demo OTP enabled, the demo code
  // IS the delivery channel: skip the real provider call so a slow or failing
  // SMS gateway cannot report `sent: false` (which the consumer UI treats as
  // a hard login failure). Production is unaffected (bypass is never active).
  if (isDevBypassActive()) return true;

  const authKey = config.msg91.authKey;
  const templateId = config.msg91.templateId;
  try {
    const res = await fetch("https://api.msg91.com/api/v5/otp", {
      method: "POST",
      headers: {
        authkey: authKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mobile: phone,
        otp,
        template_id: templateId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    // Resilience: SMS dispatch failure must not crash the request path.
    return false;
  }
}

export function opaqueOtpReceipt(phone = "+910000000000"): SendOtpResult {
  return {
    sent: true,
    phoneMasked: maskPhone(phone),
    expiresInSeconds: config.msg91.otpTtlSeconds,
    ...(isDevBypassActive() ? { demoOtp: randomInt(100000, 1000000).toString() } : {}),
  };
}

export async function sendOtp(phone: string): Promise<SendOtpResult> {
  const otp = randomInt(100000, 1000000).toString();
  const redis = getRedis();

  try {
    await redis.set(otpKey(phone), otp, "PX", otpTtlMs());
    await redis.del(attemptsKey(phone));
  } catch {
    redisUnavailable();
  }
  const sent = await sendSms(phone, otp);

  return {
    sent,
    phoneMasked: maskPhone(phone),
    expiresInSeconds: config.msg91.otpTtlSeconds,
    // On-screen demo OTP: exposed only when the dev bypass is explicitly
    // enabled (ALLOW_DEV_AUTH_BYPASS=true) or in tests, so a preview or
    // tester can complete login without an SMS gateway. The REAL generated
    // code is surfaced (not a bypass), so verification stays honest.
    ...(isDevBypassActive() ? { demoOtp: otp } : {}),
  };
}

export async function verifyOtp(
  phone: string,
  otp: string,
): Promise<{ valid: boolean; userExists: boolean }> {
  const redis = getRedis();
  let stored: string | null;
  try {
    stored = await redis.get(otpKey(phone));
  } catch {
    redisUnavailable();
  }

  // Development/preview builds: the generated code is shown automatically on
  // the login page, and ANY well-formed 6-digit code completes login. This
  // guarantees the demo can never dead-end with "Invalid OTP" or
  // "OTP expired" (stale browser bundle, manual entry, single-use consumed,
  // TTL expiry, or a dev-server restart wiping the in-memory store).
  if (isDevBypassActive()) {
    if (!/^\d{6}$/.test(otp)) {
      throw new AppError("OTP_INVALID", "Invalid OTP", 400);
    }
    if (stored) {
      try {
        await redis.del(otpKey(phone), attemptsKey(phone));
      } catch {
        redisUnavailable();
      }
    }
    return { valid: true, userExists: false };
  }

  // ---- Production path: strict, Redis-backed verification. ----
  if (!stored) {
    throw new AppError("OTP_EXPIRED", "OTP expired or not requested", 400);
  }

  // Constant-time compare to avoid timing side-channels on the OTP.
  const matches =
    stored.length === otp.length &&
    timingSafeEqual(Buffer.from(stored), Buffer.from(otp));

  if (!matches) {
    let attempts: number;
    try {
      attempts = await redis.incr(attemptsKey(phone));
      await redis.pexpire(attemptsKey(phone), otpTtlMs());
    } catch {
      redisUnavailable();
    }
    if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      try {
        await redis.del(otpKey(phone));
      } catch {
        redisUnavailable();
      }
    }
    throw new AppError("OTP_INVALID", "Invalid OTP", 400);
  }

  try {
    await redis.del(otpKey(phone), attemptsKey(phone));
  } catch {
    redisUnavailable();
  }
  return { valid: true, userExists: false };
}
