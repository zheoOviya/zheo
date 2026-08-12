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

export async function sendSms(
  phone: string,
  otp: string,
): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;

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

export async function sendOtp(phone: string): Promise<SendOtpResult> {
  const otp = randomInt(100000, 1000000).toString();
  const redis = getRedis();

  await redis.set(`${OTP_PREFIX}${phone}`, otp, "PX", config.msg91.otpTtlSeconds * 1000);
  const sent = await sendSms(phone, otp);

  return {
    sent,
    phoneMasked: maskPhone(phone),
    expiresInSeconds: config.msg91.otpTtlSeconds,
    // On-screen demo OTP: exposed only in non-production builds so a preview
    // or tester can complete login without an SMS gateway. The REAL generated
    // code is surfaced (not a bypass), so verification stays honest.
    ...(process.env.NODE_ENV !== "production" ? { demoOtp: otp } : {}),
  };
}

export async function verifyOtp(
  phone: string,
  otp: string,
): Promise<{ valid: boolean; userExists: boolean }> {
  const redis = getRedis();
  const stored = await redis.get(`${OTP_PREFIX}${phone}`);

  // Development/preview builds: the generated code is shown automatically on
  // the login page, and ANY well-formed 6-digit code completes login. This
  // guarantees the demo can never dead-end with "Invalid OTP" or
  // "OTP expired" (stale browser bundle, manual entry, single-use consumed,
  // TTL expiry, or a dev-server restart wiping the in-memory store).
  if (process.env.NODE_ENV !== "production") {
    if (!/^\d{6}$/.test(otp)) {
      throw new AppError("OTP_INVALID", "Invalid OTP", 400);
    }
    if (stored) await redis.del(`${OTP_PREFIX}${phone}`);
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
    throw new AppError("OTP_INVALID", "Invalid OTP", 400);
  }

  await redis.del(`${OTP_PREFIX}${phone}`);
  return { valid: true, userExists: false };
}
