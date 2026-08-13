import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";
import { getRedis, resetRedisForTests } from "../lib/redis";
import { sharedIdentityRepo } from "../repositories/shared";
import { generateTotpCode } from "../services/totp";

const PHONE = "+919876543210";
const LOGOUT_PHONE = "+919876000099";
const FP_A = "fp-device-a-1234567890";
const FP_B = "fp-device-b-1234567890";

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890").
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Auth routes (integration)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  async function requestOtp(phone: string) {
    const res = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone })
      .expect(200);
    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data.phoneMasked).toMatch(/\*\*\*\*/);
    // Demo build surfaces the on-screen OTP on the wire.
    expect(res.body.data.demoOtp).toMatch(/^[0-9]{6}$/);
  }

  async function readStoredOtp(phone: string): Promise<string> {
    const redis = getRedis();
    const stored = await redis.get(`otp:${phone}`);
    expect(stored).toMatch(/^[0-9]{6}$/);
    return stored as string;
  }

  it("send-otp exposes the demo OTP that matches the stored code", async () => {
    const res = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone: PHONE })
      .expect(200);
    expect(res.body.data.demoOtp).toBe(await readStoredOtp(PHONE));
  });

  it("send-otp -> verify-otp -> refresh -> logout flow", async () => {
    await requestOtp(PHONE);
    const otp = await readStoredOtp(PHONE);

    const agent = request.agent(app);
    const verifyRes = await agent
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp, device_fingerprint: FP_A })
      .expect(200);

    expect(ApiEnvelopeSchema.safeParse(verifyRes.body).success).toBe(true);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.data.access_token).toBeTruthy();
    expect(verifyRes.body.data.expires_in).toBe(900);
    expect(verifyRes.body.data.user.role).toBe("CONSUMER");

    const setCookie = verifyRes.headers["set-cookie"] as string[] | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie![0]).toContain("HttpOnly");
    // Path=/ is required so the Next.js page middleware (which checks the
    // snakzap_refresh cookie on /checkout and /orders requests) can see it.
    // A /api/v1/auth-scoped path hides the cookie from page navigations and
    // traps the user in a /login?from=/checkout redirect loop after login.
    expect(setCookie![0]).toContain("Path=/");
    const firstCookie = setCookie![0]!;

    const refreshRes = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(200);

    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.data.access_token).toBeTruthy();
    expect(refreshRes.body.data.access_token).not.toBe(verifyRes.body.data.access_token);

    // Old refresh token is now blacklisted -> reuse on a fresh agent must fail
    const reused = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", firstCookie)
      .send({ device_fingerprint: FP_A });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // Refresh again with the rotated cookie works
    const refresh2 = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(200);
    expect(refresh2.body.data.access_token).toBeTruthy();
  });

  it("logout blacklists the refresh token and clears the cookie", async () => {
    await requestOtp(LOGOUT_PHONE);
    const otp = await readStoredOtp(LOGOUT_PHONE);

    const agent = request.agent(app);
    const verifyRes = await agent
      .post("/api/v1/auth/verify-otp")
      .send({ phone: LOGOUT_PHONE, otp, device_fingerprint: FP_A })
      .expect(200);
    const setCookie = verifyRes.headers["set-cookie"] as string[] | undefined;
    expect(setCookie).toBeDefined();
    const refreshCookie = setCookie?.[0] ?? "";

    const logoutRes = await agent
      .post("/api/v1/auth/logout")
      .expect(200);
    expect(logoutRes.body.success).toBe(true);
    expect(logoutRes.body.data.logged_out).toBe(true);

    // Server must clear the httpOnly refresh cookie (Max-Age=0 / epoch expiry).
    const cleared = logoutRes.headers["set-cookie"] as string[] | undefined;
    expect(cleared).toBeDefined();
    const clearedHeader = cleared?.[0] ?? "";
    expect(clearedHeader).toContain("snakzap_refresh=;");
    expect(
      clearedHeader.includes("Max-Age=0") ||
        clearedHeader.includes("Expires=Thu, 01 Jan 1970"),
    ).toBe(true);

    // The refresh token was blacklisted server-side -> reuse must fail.
    const reused = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookie)
      .send({ device_fingerprint: FP_A });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("REFRESH_TOKEN_REUSED");
  });

  it("logout is idempotent when no refresh cookie is present", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.logged_out).toBe(true);
  });

  it("rejects refresh on device mismatch (step-up auth required)", async () => {
    await requestOtp(PHONE);
    const otp = await readStoredOtp(PHONE);

    const agent = request.agent(app);
    await agent
      .post("/api/v1/auth/verify-otp")
      .send({ phone: PHONE, otp, device_fingerprint: FP_A })
      .expect(200);

    const res = await agent
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_B })
      .expect(401);
    expect(res.body.error.code).toBe("DEVICE_MISMATCH");
  });

  it("rejects refresh without a refresh cookie", async () => {
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: FP_A })
      .expect(401);
    expect(res.body.error.code).toBe("REFRESH_TOKEN_MISSING");
  });

  it("validates request bodies with Zod", async () => {
    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: "not-a-phone", otp: "12", device_fingerprint: "x" })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces OTP rate limit of 3 per minute per phone", async () => {
    for (let i = 0; i < 3; i++) {
      await requestOtp(PHONE);
    }
    const blocked = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone: PHONE })
      .expect(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

// ============================================
// TOTP 2FA (2-step login)
// ============================================

describe("TOTP 2FA (2-step login)", () => {
  const TOTP_PHONE = "+919876000050";
  const ENROLL_PHONE = "+919876000051";
  const TOTP_USER_ID = "u-totp-test-0000000000001";
  const ENROLL_USER_ID = "u-totp-enroll-00000000001";

  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  async function requestOtp(phone: string) {
    const res = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone })
      .expect(200);
    return res.body.data.demoOtp as string;
  }

  async function loginNormal(phone: string, device = FP_A): Promise<string> {
    const otp = await requestOtp(phone);
    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp, device_fingerprint: device })
      .expect(200);
    return res.body.data.access_token as string;
  }

  function seedTotpEnabledUser() {
    sharedIdentityRepo._seed({
      id: TOTP_USER_ID,
      phone: TOTP_PHONE,
      role: "ADMIN",
      is_suspended: false,
      totp_secret: RFC_SECRET_BASE32,
      totp_enabled: true,
      totp_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  }

  function seedEnrollUser() {
    sharedIdentityRepo._seed({
      id: ENROLL_USER_ID,
      phone: ENROLL_PHONE,
      role: "CONSUMER",
      is_suspended: false,
      totp_secret: null,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    });
  }

  async function getTotpTicket(phone: string): Promise<string> {
    const otp = await requestOtp(phone);
    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp, device_fingerprint: FP_A })
      .expect(202);
    expect(res.body.data.totp_required).toBe(true);
    return res.body.data.totp_ticket as string;
  }

  it("verify-otp returns a 2FA ticket instead of tokens when TOTP is enabled", async () => {
    seedTotpEnabledUser();
    const ticket = await getTotpTicket(TOTP_PHONE);
    expect(ticket.length).toBeGreaterThan(20);
  });

  it("totp/verify completes login with a valid code and sets the refresh cookie", async () => {
    seedTotpEnabledUser();
    const ticket = await getTotpTicket(TOTP_PHONE);
    const code = generateTotpCode(RFC_SECRET_BASE32);

    const res = await request(app)
      .post("/api/v1/auth/totp/verify")
      .send({
        totp_ticket: ticket,
        code,
        device_fingerprint: FP_A,
        phone: TOTP_PHONE,
      })
      .expect(200);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user.role).toBe("ADMIN");
    const setCookie = res.headers["set-cookie"] as string[] | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie![0]).toContain("HttpOnly");
  });

  it("totp/verify rejects an invalid code", async () => {
    seedTotpEnabledUser();
    const ticket = await getTotpTicket(TOTP_PHONE);
    const res = await request(app)
      .post("/api/v1/auth/totp/verify")
      .send({
        totp_ticket: ticket,
        code: "000000",
        device_fingerprint: FP_A,
        phone: TOTP_PHONE,
      })
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOTP");
  });

  it("totp/verify rejects a ticket presented from another device", async () => {
    seedTotpEnabledUser();
    const ticket = await getTotpTicket(TOTP_PHONE);
    const code = generateTotpCode(RFC_SECRET_BASE32);
    const res = await request(app)
      .post("/api/v1/auth/totp/verify")
      .send({
        totp_ticket: ticket,
        code,
        device_fingerprint: FP_B,
        phone: TOTP_PHONE,
      })
      .expect(401);
    expect(res.body.error.code).toBe("DEVICE_MISMATCH");
  });

  it("totp/status requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/auth/totp/status")
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("enroll -> confirm -> status -> disable self-service flow", async () => {
    seedEnrollUser();
    const token = await loginNormal(ENROLL_PHONE);

    const statusBefore = await request(app)
      .post("/api/v1/auth/totp/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(statusBefore.body.data).toEqual({
      totp_enabled: false,
      enrolled: false,
      totp_confirmed_at: null,
    });

    const enrollRes = await request(app)
      .post("/api/v1/auth/totp/enroll")
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    const secret = enrollRes.body.data.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollRes.body.data.otpauth_url).toContain(`secret=${secret}`);
    expect(enrollRes.body.data.otpauth_url).toContain("otpauth://totp/");

    const statusEnrolled = await request(app)
      .post("/api/v1/auth/totp/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(statusEnrolled.body.data).toMatchObject({
      totp_enabled: false,
      enrolled: true,
    });

    const wrongConfirm = await request(app)
      .post("/api/v1/auth/totp/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "000000" })
      .expect(401);
    expect(wrongConfirm.body.error.code).toBe("INVALID_TOTP");

    const confirmRes = await request(app)
      .post("/api/v1/auth/totp/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: generateTotpCode(secret) })
      .expect(200);
    expect(confirmRes.body.data.totp_enabled).toBe(true);

    const statusEnabled = await request(app)
      .post("/api/v1/auth/totp/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(statusEnabled.body.data.totp_enabled).toBe(true);

    // Disabling requires a fresh valid code.
    const disableRes = await request(app)
      .post("/api/v1/auth/totp/disable")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: generateTotpCode(secret) })
      .expect(200);
    expect(disableRes.body.data.totp_enabled).toBe(false);

    const statusDisabled = await request(app)
      .post("/api/v1/auth/totp/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(statusDisabled.body.data).toMatchObject({
      totp_enabled: false,
      enrolled: false,
    });
  });

  it("re-enrolling an already-enabled account is rejected", async () => {
    seedTotpEnabledUser();
    const otp = await requestOtp(TOTP_PHONE);
    const ticket = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone: TOTP_PHONE, otp, device_fingerprint: FP_A })
      .expect(202);
    const code = generateTotpCode(RFC_SECRET_BASE32);
    const loginRes = await request(app)
      .post("/api/v1/auth/totp/verify")
      .send({
        totp_ticket: ticket.body.data.totp_ticket,
        code,
        device_fingerprint: FP_A,
        phone: TOTP_PHONE,
      })
      .expect(200);
    const token = loginRes.body.data.access_token as string;

    const res = await request(app)
      .post("/api/v1/auth/totp/enroll")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("confirm before enrolling is rejected", async () => {
    seedEnrollUser();
    const token = await loginNormal(ENROLL_PHONE);
    const res = await request(app)
      .post("/api/v1/auth/totp/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "123456" })
      .expect(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });
});

// ============================================
// Admin console login (email -> OTP on linked mobile)
// ============================================

describe("Admin email login (email -> mobile OTP)", () => {
  const ADMIN_EMAIL = "ops@snakzap.dev";
  const ADMIN_PHONE = "+919876000060";
  const ADMIN_ID = "u-admin-email-000000000001";
  const TOTP_EMAIL = "secops@snakzap.dev";
  const TOTP_PHONE = "+919876000061";
  const TOTP_ID = "u-admin-totp-000000000001";
  const FP = "admin-fp-000000000001";

  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  function seedOperators() {
    sharedIdentityRepo._seed({
      id: ADMIN_ID,
      phone: ADMIN_PHONE,
      email: ADMIN_EMAIL,
      role: "ADMIN",
      is_suspended: false,
      totp_secret: null,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    });
    sharedIdentityRepo._seed({
      id: TOTP_ID,
      phone: TOTP_PHONE,
      email: TOTP_EMAIL,
      role: "SUPER_ADMIN",
      is_suspended: false,
      totp_secret: RFC_SECRET_BASE32,
      totp_enabled: true,
      totp_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  }

  it("send-otp resolves the email to the linked mobile and exposes the demo OTP", async () => {
    seedOperators();
    const res = await request(app)
      .post("/api/v1/auth/admin/send-otp")
      .send({ email: ADMIN_EMAIL })
      .expect(200);
    expect(res.body.data.phoneMasked).toMatch(/\*\*\*\*/);
    expect(res.body.data.demoOtp).toMatch(/^[0-9]{6}$/);
  });

  it("rejects unknown or non-operator emails", async () => {
    seedOperators();
    sharedIdentityRepo._seed({
      id: "u-consumer-email-00000001",
      phone: "+919876000062",
      email: "buyer@snakzap.dev",
      role: "CONSUMER",
      is_suspended: false,
      totp_enabled: false,
      created_at: new Date().toISOString(),
    });
    for (const email of ["nobody@snakzap.dev", "buyer@snakzap.dev"]) {
      const res = await request(app)
        .post("/api/v1/auth/admin/send-otp")
        .send({ email })
        .expect(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("verify-otp completes admin login with the code from the linked mobile", async () => {
    seedOperators();
    await request(app)
      .post("/api/v1/auth/admin/send-otp")
      .send({ email: ADMIN_EMAIL })
      .expect(200);
    const stored = await getRedis().get(`otp:${ADMIN_PHONE}`);
    expect(stored).toMatch(/^[0-9]{6}$/);

    const agent = request.agent(app);
    const res = await agent
      .post("/api/v1/auth/admin/verify-otp")
      .send({ email: ADMIN_EMAIL, otp: stored, device_fingerprint: FP })
      .expect(200);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.user.role).toBe("ADMIN");
    const setCookie = res.headers["set-cookie"] as string[] | undefined;
    expect(setCookie).toBeDefined();
    expect(setCookie![0]).toContain("HttpOnly");
  });

  it("TOTP-enabled operators get a ticket + phone instead of tokens", async () => {
    seedOperators();
    await request(app)
      .post("/api/v1/auth/admin/send-otp")
      .send({ email: TOTP_EMAIL })
      .expect(200);
    const stored = await getRedis().get(`otp:${TOTP_PHONE}`);
    const res = await request(app)
      .post("/api/v1/auth/admin/verify-otp")
      .send({ email: TOTP_EMAIL, otp: stored, device_fingerprint: FP })
      .expect(202);
    expect(res.body.data.totp_required).toBe(true);
    expect(res.body.data.totp_ticket).toBeTruthy();
    expect(res.body.data.phone).toBe(TOTP_PHONE);
    expect(res.body.data.access_token).toBeUndefined();
  });
});
