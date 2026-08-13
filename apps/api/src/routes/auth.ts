import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { generateEventMetadata } from "../lib/correlation";
import { logger } from "../lib/logger";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { rateLimiter } from "../middleware/rateLimiter";
import { requireRole } from "../middleware/requireRoles";
import { sharedAuditRepo, sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";
import { sendOtp, verifyOtp } from "../services/otp";
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from "../services/totp";

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

const totpLimiter = rateLimiter({
  prefix: "totp",
  max: 5,
  windowMs: 60_000,
  identifier: (req) => String(req.body?.phone ?? req.ip ?? "unknown"),
  failClosed: true,
});

// Self-service 2FA endpoints are available to every authenticated role.
const ALL_AUTH_ROLES = [
  "CONSUMER",
  "VENDOR_OWNER",
  "VENDOR_STAFF",
  "OPS_AGENT",
  "ADMIN",
  "SUPER_ADMIN",
];

const TotpTicketSchema = z.object({
  totp_ticket: z.string().min(10, "totp_ticket missing"),
  code: z.string().regex(/^[0-9]{6}$/, "Code must be 6 digits"),
  device_fingerprint: z.string().min(8, "device_fingerprint too short"),
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
});

const TotpCodeSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, "Code must be 6 digits"),
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
  otpLimiter,
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

    // 2FA: TOTP-enabled accounts pause after the OTP factor and get a
    // short-lived ticket instead of tokens; /totp/verify completes login.
    if (user.totp_enabled) {
      const totpTicket = jwtService.signTotpTicket(claims);
      logger.info({
        message: "otp_verified_totp_required",
        user_id: user.id,
        correlation_id: res.locals.correlationId,
      });
      await sharedAuditRepo.log(user.id, "totp_step_required", {
        event: "OtpVerified",
        correlation_id: res.locals.correlationId,
      });
      ok(res, {
        totp_required: true,
        totp_ticket: totpTicket,
      }, 202);
      return;
    }

    const pair = jwtService.issuePair(claims);

    res.cookie(config.jwt.refreshCookieName, pair.refreshToken, {
      httpOnly: true,
      secure: config.env === "production",
      sameSite: "strict",
      path: "/",
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
      path: "/",
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
    res.clearCookie(config.jwt.refreshCookieName, { path: "/" });
    ok(res, { logged_out: true });
  }),
);

// ============================================
// TOTP 2FA endpoints
// ============================================

// Completes the 2-step login: OTP -> TOTP ticket -> token pair.
authRouter.post(
  "/totp/verify",
  totpLimiter,
  asyncHandler(async (req, res) => {
    const body = TotpTicketSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const ticket = jwtService.verifyTotpTicket(body.data.totp_ticket);
    if (ticket.device_fingerprint !== body.data.device_fingerprint) {
      throw new AppError("DEVICE_MISMATCH", "2FA ticket device mismatch", 401);
    }

    const user = await sharedIdentityRepo.getById(ticket.sub);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    if (!user.totp_enabled || !user.totp_secret) {
      throw new AppError("CONFLICT", "2FA is not enabled for this account", 409);
    }
    if (!verifyTotpCode(user.totp_secret, body.data.code)) {
      await sharedAuditRepo.log(user.id, "totp_verify_failed", {
        correlation_id: res.locals.correlationId,
      });
      throw new AppError("INVALID_TOTP", "Invalid authenticator code", 401);
    }

    const pair = jwtService.issuePair({
      sub: user.id,
      phone: user.phone,
      role: user.role,
      device_fingerprint: body.data.device_fingerprint,
    });

    res.cookie(config.jwt.refreshCookieName, pair.refreshToken, {
      httpOnly: true,
      secure: config.env === "production",
      sameSite: "strict",
      path: "/",
      maxAge: config.jwt.refreshTtlSeconds * 1000,
    });

    logger.info({
      message: "totp_verified_login",
      user_id: user.id,
      correlation_id: res.locals.correlationId,
    });
    await sharedAuditRepo.log(user.id, "totp_verified", {
      event: "OtpVerified",
      correlation_id: res.locals.correlationId,
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
      user: { id: user.id, phone: user.phone, role: user.role },
    }, 200);
  }),
);

// 2FA status for the current session.
authRouter.post(
  "/totp/status",
  requireRole(...ALL_AUTH_ROLES),
  asyncHandler(async (req, res) => {
    const user = await sharedIdentityRepo.getById(res.locals.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    ok(res, {
      totp_enabled: user.totp_enabled,
      enrolled: Boolean(user.totp_secret),
      totp_confirmed_at: user.totp_confirmed_at ?? null,
    });
  }),
);

// Starts enrollment: generates + persists a fresh secret, returns otpauth URL.
authRouter.post(
  "/totp/enroll",
  requireRole(...ALL_AUTH_ROLES),
  asyncHandler(async (req, res) => {
    const user = await sharedIdentityRepo.getById(res.locals.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    if (user.totp_enabled) {
      throw new AppError(
        "CONFLICT",
        "2FA is already enabled. Disable it first to re-enroll.",
        409,
      );
    }
    const secret = generateTotpSecret();
    const updated = await sharedIdentityRepo.setTotpSecret(user.id, secret);
    if (!updated) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    await sharedAuditRepo.log(user.id, "totp_enrolled", {
      correlation_id: res.locals.correlationId,
    });
    ok(res, {
      secret,
      otpauth_url: buildOtpauthUrl(secret, user.phone, "SnakZap"),
    }, 201);
  }),
);

// Confirms enrollment by validating the app-generated code, then activates 2FA.
authRouter.post(
  "/totp/confirm",
  totpLimiter,
  requireRole(...ALL_AUTH_ROLES),
  asyncHandler(async (req, res) => {
    const body = TotpCodeSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await sharedIdentityRepo.getById(res.locals.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    if (user.totp_enabled) {
      throw new AppError("CONFLICT", "2FA is already enabled", 409);
    }
    if (!user.totp_secret) {
      throw new AppError("CONFLICT", "No pending 2FA enrollment", 409);
    }
    if (!verifyTotpCode(user.totp_secret, body.data.code)) {
      await sharedAuditRepo.log(user.id, "totp_confirm_failed", {
        correlation_id: res.locals.correlationId,
      });
      throw new AppError("INVALID_TOTP", "Invalid authenticator code", 401);
    }
    await sharedIdentityRepo.enableTotp(user.id);
    await sharedAuditRepo.log(user.id, "totp_confirmed", {
      correlation_id: res.locals.correlationId,
    });
    ok(res, { totp_enabled: true, totp_confirmed_at: new Date().toISOString() }, 200);
  }),
);

// Disables 2FA after validating a current code.
authRouter.post(
  "/totp/disable",
  totpLimiter,
  requireRole(...ALL_AUTH_ROLES),
  asyncHandler(async (req, res) => {
    const body = TotpCodeSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await sharedIdentityRepo.getById(res.locals.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    if (!user.totp_enabled || !user.totp_secret) {
      throw new AppError("CONFLICT", "2FA is not enabled", 409);
    }
    if (!verifyTotpCode(user.totp_secret, body.data.code)) {
      await sharedAuditRepo.log(user.id, "totp_disable_failed", {
        correlation_id: res.locals.correlationId,
      });
      throw new AppError("INVALID_TOTP", "Invalid authenticator code", 401);
    }
    await sharedIdentityRepo.disableTotp(user.id);
    await sharedAuditRepo.log(user.id, "totp_disabled", {
      correlation_id: res.locals.correlationId,
    });
    ok(res, { totp_enabled: false }, 200);
  }),
);
