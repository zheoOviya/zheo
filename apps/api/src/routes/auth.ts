import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { generateEventMetadata } from "../lib/correlation";
import { logger } from "../lib/logger";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { rateLimiter } from "../middleware/rateLimiter";
import { requireRole } from "../middleware/requireRoles";
import { sharedAuditRepo, sharedIdentityRepo } from "../repositories/shared";
import type { IdentityUser } from "../repositories/identityRepository";
import { jwtService } from "../services/jwt";
import { sendOtp, verifyOtp, maskPhone, normalizePhone } from "../services/otp";
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from "../services/totp";

// ============================================
// Auth routes (identity context) - /api/v1/auth
// ============================================

const PhoneSchema = z.object({
  phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/, "Invalid phone number")
    .transform((p) => normalizePhone(p)),
});

const VerifyOtpSchema = z.object({
  phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/, "Invalid phone number")
    .transform((p) => normalizePhone(p)),
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

// Admin console login is email-keyed: the OTP is delivered to the operator's
// linked mobile number (resolved by email on the server).
const AdminEmailSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const AdminVerifyOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().regex(/^[0-9]{6}$/, "OTP must be 6 digits"),
  device_fingerprint: z.string().min(8, "device_fingerprint too short"),
});

const OPERATOR_ROLES = ["ADMIN", "SUPER_ADMIN"];

const adminOtpLimiter = rateLimiter({
  prefix: "otp-admin",
  max: config.rateLimit.otpMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => String(req.body?.email ?? req.ip ?? "unknown").toLowerCase(),
  failClosed: true,
});

const vendorOtpLimiter = rateLimiter({
  prefix: "otp-vendor",
  max: config.rateLimit.otpMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => String(req.body?.phone ?? req.ip ?? "unknown"),
  failClosed: true,
});

// Vendor sign-in has a 3-step flow (send-otp probe -> signup -> send-otp ->
// verify-otp), so verify gets its own budget instead of sharing the
// send-otp/signup window. Otherwise a brand-new merchant would always trip
// the 3/min limit before they can enter the OTP.
const vendorVerifyOtpLimiter = rateLimiter({
  prefix: "otp-vendor-verify",
  max: config.rateLimit.otpMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => String(req.body?.phone ?? req.ip ?? "unknown"),
  failClosed: true,
});

const consumerOtpLimiter = rateLimiter({
  prefix: "otp-consumer",
  max: config.rateLimit.otpMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => String(req.body?.phone ?? req.ip ?? "unknown"),
  failClosed: true,
});

async function resolveOperatorByEmail(email: string): Promise<IdentityUser> {
  const user = await sharedIdentityRepo.getByEmail(email);
  if (!user || !OPERATOR_ROLES.includes(user.role)) {
    throw new AppError(
      "FORBIDDEN",
      "Unknown email or not an operator account",
      403,
    );
  }
  if (user.is_suspended) {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403);
  }
  return user;
}

export const authRouter: Router = Router();

// Phone-keyed stable identity so repeat customers keep the
// same user_id across sessions and channels (web + POS).
async function resolveUser(phone: string) {
  return sharedIdentityRepo.ensureByPhone(phone, "CONSUMER");
}

// Issues both auth cookies: the httpOnly refresh cookie (7d) and the
// httpOnly access cookie (15m). The access cookie lets the browser
// authenticate API calls without exposing the JWT to JavaScript
// (previously it was returned in the body and stored in localStorage).
function setAuthCookies(
  res: Response,
  pair: { accessToken: string; refreshToken: string },
): void {
  res.cookie(config.jwt.refreshCookieName, pair.refreshToken, {
    httpOnly: true,
    secure: config.env === "production",
    sameSite: "strict",
    path: "/",
    maxAge: config.jwt.refreshTtlSeconds * 1000,
  });
  res.cookie(config.jwt.accessCookieName, pair.accessToken, {
    httpOnly: true,
    secure: config.env === "production",
    sameSite: "strict",
    path: "/",
    maxAge: config.jwt.accessTtlSeconds * 1000,
  });
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
        phone: user.phone,
      }, 202);
      return;
    }

    const pair = jwtService.issuePair(claims);

    setAuthCookies(res, pair);

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

    setAuthCookies(res, pair);

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
    res.clearCookie(config.jwt.accessCookieName, { path: "/" });
    ok(res, { logged_out: true });
  }),
);

// Current-session identity. The frontends use this to hydrate their UI (role,
// user id, suspension state) after a hard reload, since the access token now
// lives in an httpOnly cookie rather than localStorage. Any valid session
// (including PENDING_VENDOR) may call it.
authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await sharedIdentityRepo.getById(res.locals.userId);
    if (!user) {
      throw new AppError("UNAUTHORIZED", "User no longer exists", 401);
    }
    ok(res, {
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role,
        is_suspended: user.is_suspended,
      },
    }, 200);
  }),
);

// ============================================
// Admin console login (email -> OTP on linked mobile)
// The admin app signs in with an operator email; the OTP is sent to and
// verified against the linked mobile number stored on the account.
// ============================================

authRouter.post(
  "/admin/send-otp",
  adminOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = AdminEmailSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await resolveOperatorByEmail(body.data.email);
    const result = await sendOtp(user.phone);
    logger.info({
      message: "admin_otp_sent",
      email: body.data.email.toLowerCase(),
      phone_masked: result.phoneMasked,
      correlation_id: res.locals.correlationId,
    });
    ok(res, result);
  }),
);

authRouter.post(
  "/admin/verify-otp",
  adminOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = AdminVerifyOtpSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const user = await resolveOperatorByEmail(body.data.email);
    await verifyOtp(user.phone, body.data.otp);

    const claims = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      device_fingerprint: body.data.device_fingerprint,
    };

    // 2FA: TOTP-enabled operators get a ticket + phone to finish login.
    if (user.totp_enabled) {
      const totpTicket = jwtService.signTotpTicket(claims);
      await sharedAuditRepo.log(user.id, "totp_step_required", {
        event: "AdminOtpVerified",
        correlation_id: res.locals.correlationId,
      });
      ok(res, {
        totp_required: true,
        totp_ticket: totpTicket,
        phone: user.phone,
      }, 202);
      return;
    }

    const pair = jwtService.issuePair(claims);

    setAuthCookies(res, pair);

    logger.info({
      message: "admin_otp_verified",
      user_id: user.id,
      correlation_id: res.locals.correlationId,
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
      user: { id: user.id, phone: user.phone, role: user.role },
    }, 200);
  }),
);

// ============================================
// Vendor console login (phone -> OTP)
// New merchants sign up as PENDING_VENDOR and can then sign in with the
// same phone+OTP flow. PENDING_VENDOR accounts cannot access /api/vendor
// routes until an admin approves their onboarding (role upgraded to
// VENDOR_OWNER / VENDOR_STAFF).
// ============================================

const VENDOR_ROLES = ["PENDING_VENDOR", "VENDOR_OWNER", "VENDOR_STAFF"];

async function resolveVendorUser(phone: string): Promise<IdentityUser> {
  const user = await sharedIdentityRepo.getByPhone(phone);
  if (!user || !VENDOR_ROLES.includes(user.role)) {
    throw new AppError(
      "VENDOR_NOT_FOUND",
      "No vendor account found for this phone",
      404,
    );
  }
  if (user.is_suspended) {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403);
  }
  return user;
}

authRouter.post(
  "/vendor/signup",
  vendorOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = PhoneSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await sharedIdentityRepo.createByPhone(body.data.phone, "PENDING_VENDOR");
    if (!user) {
      throw new AppError(
        "PHONE_TAKEN",
        "An account already exists for this phone",
        409,
      );
    }
    logger.info({
      message: "vendor_signup",
      user_id: user.id,
      phone_masked: maskPhone(user.phone),
      correlation_id: res.locals.correlationId,
    });
    ok(res, { id: user.id, phone: user.phone, role: user.role }, 201);
  }),
);

authRouter.post(
  "/vendor/send-otp",
  vendorOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = PhoneSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await resolveVendorUser(body.data.phone);
    const result = await sendOtp(user.phone);
    logger.info({
      message: "vendor_otp_sent",
      phone_masked: result.phoneMasked,
      correlation_id: res.locals.correlationId,
    });
    ok(res, result);
  }),
);

authRouter.post(
  "/vendor/verify-otp",
  vendorVerifyOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = VerifyOtpSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const user = await resolveVendorUser(body.data.phone);
    await verifyOtp(user.phone, body.data.otp);

    const claims = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      device_fingerprint: body.data.device_fingerprint,
    };

    const pair = jwtService.issuePair(claims);

    setAuthCookies(res, pair);

    logger.info({
      message: "vendor_otp_verified",
      user_id: user.id,
      correlation_id: res.locals.correlationId,
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
      user: { id: user.id, phone: user.phone, role: user.role, is_suspended: user.is_suspended },
    }, 200);
  }),
);

// ============================================
// Consumer sign-in / sign-up (phone -> OTP)
// Consumers sign up implicitly: send-otp auto-creates a CONSUMER identity
// when the phone is new, so the login page needs no separate sign-up step.
// ============================================

async function resolveConsumerUser(phone: string): Promise<IdentityUser> {
  const user = await sharedIdentityRepo.getByPhone(phone);
  if (!user || user.role !== "CONSUMER") {
    throw new AppError(
      "CONSUMER_NOT_FOUND",
      "No consumer account found for this phone",
      404,
    );
  }
  if (user.is_suspended) {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403);
  }
  return user;
}

// Sign-up is implicit: a brand-new phone is auto-created as a CONSUMER on the
// first send-otp, so there is no separate sign-up round-trip.
async function findOrCreateConsumer(phone: string): Promise<IdentityUser> {
  const existing = await sharedIdentityRepo.getByPhone(phone);
  if (existing) {
    if (existing.role !== "CONSUMER") {
      throw new AppError(
        "CONSUMER_NOT_FOUND",
        "No consumer account found for this phone",
        404,
      );
    }
    if (existing.is_suspended) {
      throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended", 403);
    }
    return existing;
  }
  const user = await sharedIdentityRepo.createByPhone(phone, "CONSUMER");
  if (!user) {
    throw new AppError(
      "PHONE_TAKEN",
      "An account already exists for this phone",
      409,
    );
  }
  logger.info({
    message: "consumer_signup_implicit",
    user_id: user.id,
    phone_masked: maskPhone(user.phone),
  });
  return user;
}

authRouter.post(
  "/consumer/send-otp",
  consumerOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = PhoneSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }
    const user = await findOrCreateConsumer(body.data.phone);
    const result = await sendOtp(user.phone);
    logger.info({
      message: "consumer_otp_sent",
      phone_masked: result.phoneMasked,
      correlation_id: res.locals.correlationId,
    });
    ok(res, result);
  }),
);

authRouter.post(
  "/consumer/verify-otp",
  consumerOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = VerifyOtpSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const user = await resolveConsumerUser(body.data.phone);
    await verifyOtp(user.phone, body.data.otp);

    const claims = {
      sub: user.id,
      phone: user.phone,
      role: user.role,
      device_fingerprint: body.data.device_fingerprint,
    };

    const pair = jwtService.issuePair(claims);

    setAuthCookies(res, pair);

    logger.info({
      message: "consumer_otp_verified",
      user_id: user.id,
      correlation_id: res.locals.correlationId,
    });

    ok(res, {
      access_token: pair.accessToken,
      expires_in: config.jwt.accessTtlSeconds,
      user: { id: user.id, phone: user.phone, role: user.role, is_suspended: user.is_suspended },
    }, 200);
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

    setAuthCookies(res, pair);

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
