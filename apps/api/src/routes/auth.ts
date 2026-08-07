import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { generateEventMetadata } from "../lib/correlation";
import { logger } from "../lib/logger";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { rateLimiter } from "../middleware/rateLimiter";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";
import { sendOtp, verifyOtp } from "../services/otp";

// ============================================
// Auth routes (identity context) - /api/v1/auth
// ============================================

const PhoneSchema = z.object({
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
});

const VerifyOtpSchema = z.object({
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
  otp: z.string().regex(/^[0-9]{6}$/, "OTP must be 6 digits"),
  device_fingerprint: z.string().min(8, "device_fingerprint too short"),
});

const RefreshSchema = z.object({
  device_fingerprint: z.string().min(8, "device_fingerprint too short"),
});

const otpLimiter = rateLimiter({
  prefix: "otp",
  max: config.rateLimit.otpMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => req.body?.phone ?? req.ip ?? "unknown",
  failClosed: true,
});

export const authRouter: Router = Router();

// Phone-keyed stable identity so repeat customers keep the
// same user_id across sessions and channels (web + POS).
async function resolveUser(phone: string) {
  return sharedIdentityRepo.ensureByPhone(phone, "CONSUMER");
}

authRouter.post(
  "/send-otp",
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = PhoneSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const result = await sendOtp(body.data.phone);
    logger.info({
      message: "otp_sent",
      phone_masked: result.phoneMasked,
      correlation_id: res.locals.correlationId,
    });
    ok(res, result);
  }),
);

authRouter.post(
  "/verify-otp",
  asyncHandler(async (req, res) => {
    const body = VerifyOtpSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    await verifyOtp(body.data.phone, body.data.otp);

    const user = await resolveUser(body.data.phone);
    const claims = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      device_fingerprint: body.data.device_fingerprint,
    };
    const pair = jwtService.issuePair(claims);

    res.cookie(config.jwt.refreshCookieName, pair.refreshToken, {
      httpOnly: true,
      secure: config.env === "production",
      sameSite: "strict",
      path: "/api/v1/auth",
      maxAge: config.jwt.refreshTtlSeconds * 1000,
    });

    logger.info({
      message: "otp_verified",
      user_id: user.id,
      correlation_id: res.locals.correlationId,
      event: "OTPGenerated",
      event_metadata: generateEventMetadata(res),
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
      user: { id: user.id, phone: user.phone, role: user.role },
    }, 200);
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const body = RefreshSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const oldRefresh = req.cookies?.[config.jwt.refreshCookieName] as string | undefined;
    if (!oldRefresh) {
      throw new AppError("REFRESH_TOKEN_MISSING", "No refresh token cookie", 401);
    }

    const pair = await jwtService.rotateRefreshToken(
      oldRefresh,
      body.data.device_fingerprint,
    );

    res.cookie(config.jwt.refreshCookieName, pair.refreshToken, {
      httpOnly: true,
      secure: config.env === "production",
      sameSite: "strict",
      path: "/api/v1/auth",
      maxAge: config.jwt.refreshTtlSeconds * 1000,
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
    });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const refresh = req.cookies?.[config.jwt.refreshCookieName] as string | undefined;
    if (refresh) {
      try {
        const claims = jwtService.verifyRefreshToken(refresh);
        if (claims.jti) await jwtService.blacklistRefreshToken(claims.jti);
      } catch {
        // invalid token is fine for logout
      }
    }
    res.clearCookie(config.jwt.refreshCookieName, { path: "/api/v1/auth" });
    ok(res, { logged_out: true });
  }),
);
