import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { incrementSessionEpoch } from "../lib/sessionEpoch";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";
import { seedAuthIdentity } from "../test/support/authIdentity";

const ACCESS_SECRET =
  process.env.JWT_SECRET ?? "test-access-secret-at-least-32-characters-long";
const REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-at-least-32-characters-long";

const ADMIN_ID = "admin-rbac-00000000000001";
const CONSUMER_ID = "consumer-rbac-00000000001";
const VENDOR_ID = "vendor-rbac-00000000000001";
const FP = "fp_require_roles_g2_01";

function token(role: string, sub: string, phone = "+919876543210"): string {
  seedAuthIdentity({ sub, phone, role });
  return jwtService.signAccessToken({
    sub,
    phone,
    role,
    device_fingerprint: FP,
  });
}

function bearer(role: string, sub: string, phone?: string) {
  return { Authorization: `Bearer ${token(role, sub, phone)}` };
}

function signLegacyAccess(overrides: Record<string, unknown> = {}): string {
  const sub = (overrides.sub as string) ?? ADMIN_ID;
  const rest = {
    phone: "+919876543210",
    role: "ADMIN",
    device_fingerprint: FP,
    type: "access",
    jti: "legacy-access-jti",
    ...overrides,
  };
  delete (rest as { sub?: string }).sub;
  return jwt.sign(rest, ACCESS_SECRET, {
    subject: sub,
    expiresIn: 900,
    issuer: "snakzap",
  });
}

describe("AUTH-G2 requireRole current DB role + epoch", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    app = createApp();
  });

  it("returns 401 when the access token is missing", async () => {
    const res = await request(app).get("/api/v1/admin/metrics").expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when Authorization is not Bearer", async () => {
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", "Basic dGVzdDp0ZXN0")
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for a random invalid token", async () => {
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", "Bearer this-is-not-a-jwt")
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 for an expired access token", async () => {
    const expired = jwt.sign(
      {
        phone: "+919876543210",
        role: "ADMIN",
        device_fingerprint: FP,
        type: "access",
        jti: "expired-jti",
        session_epoch: 0,
      },
      ACCESS_SECRET,
      { subject: ADMIN_ID, expiresIn: "-1s", issuer: "snakzap" },
    );
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${expired}`)
      .expect(401);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects a refresh token used as access", async () => {
    const { token: refreshToken } = jwtService.signRefreshToken({
      sub: ADMIN_ID,
      phone: "+919876543210",
      role: "ADMIN",
      device_fingerprint: FP,
    });
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${refreshToken}`)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects a legacy access token without session_epoch", async () => {
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${signLegacyAccess()}`)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("fails closed on a malformed session_epoch claim", async () => {
    const bad = signLegacyAccess({ session_epoch: "0" });
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${bad}`)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("fails closed on a negative session_epoch claim", async () => {
    const bad = signLegacyAccess({ session_epoch: -1 });
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${bad}`)
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects access after the session epoch is bumped", async () => {
    const access = token("ADMIN", ADMIN_ID);
    await incrementSessionEpoch(ADMIN_ID);
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${access}`)
      .expect(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("CONSUMER is 403 on adminReadOnly", async () => {
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set(bearer("CONSUMER", CONSUMER_ID, "+918888888888"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("VENDOR_OWNER is 403 on adminReadOnly", async () => {
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set(bearer("VENDOR_OWNER", VENDOR_ID, "+919876000101"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("OPS_AGENT is allowed on adminReadOnly", async () => {
    await request(app)
      .get("/api/v1/admin/metrics")
      .set(bearer("OPS_AGENT", ADMIN_ID))
      .expect(200);
  });

  it("ADMIN is allowed on adminReadOnly", async () => {
    await request(app)
      .get("/api/v1/admin/metrics")
      .set(bearer("ADMIN", ADMIN_ID))
      .expect(200);
  });

  it("SUPER_ADMIN is allowed on adminReadOnly", async () => {
    await request(app)
      .get("/api/v1/admin/metrics")
      .set(bearer("SUPER_ADMIN", ADMIN_ID))
      .expect(200);
  });

  it("OPS_AGENT is 403 on adminWrite", async () => {
    const res = await request(app)
      .put("/api/v1/admin/kill-switches/vendor_churn_protection")
      .set(bearer("OPS_AGENT", ADMIN_ID))
      .send({ enabled: true })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("ADMIN is allowed on adminWrite", async () => {
    await request(app)
      .put("/api/v1/admin/kill-switches/vendor_churn_protection")
      .set(bearer("ADMIN", ADMIN_ID))
      .send({ enabled: true })
      .expect(200);
  });

  it("CONSUMER is 403 on adminWrite", async () => {
    const res = await request(app)
      .put("/api/v1/admin/kill-switches/vendor_churn_protection")
      .set(bearer("CONSUMER", CONSUMER_ID, "+918888888888"))
      .send({ enabled: true })
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("uses the current DB role, not a stale JWT ADMIN claim", async () => {
    const access = token("ADMIN", ADMIN_ID);
    await sharedIdentityRepo.updateRole(ADMIN_ID, "CONSUMER");
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${access}`)
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message).toContain("CONSUMER");
  });

  it("uses the current DB role after an upgrade", async () => {
    const access = token("CONSUMER", ADMIN_ID);
    await sharedIdentityRepo.updateRole(ADMIN_ID, "ADMIN");
    await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
  });

  it("rejects a suspended account", async () => {
    const access = token("ADMIN", ADMIN_ID);
    await sharedIdentityRepo.suspend(ADMIN_ID, "g2");
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${access}`)
      .expect(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("rejects a deleted account", async () => {
    const access = token("ADMIN", ADMIN_ID);
    sharedIdentityRepo._reset();
    const res = await request(app)
      .get("/api/v1/admin/metrics")
      .set("Authorization", `Bearer ${access}`)
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requireConsumerOrAdmin allows CONSUMER on /cart", async () => {
    await request(app).get("/api/v1/cart").set(bearer("CONSUMER", CONSUMER_ID)).expect(200);
  });

  it("requireConsumerOrAdmin allows ADMIN on /cart", async () => {
    await request(app).get("/api/v1/cart").set(bearer("ADMIN", ADMIN_ID)).expect(200);
  });

  it("requireConsumerOrAdmin rejects VENDOR_OWNER on /cart", async () => {
    const res = await request(app)
      .get("/api/v1/cart")
      .set(bearer("VENDOR_OWNER", VENDOR_ID, "+919876000101"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("PENDING_VENDOR is not in ALL_AUTH_ROLES", async () => {
    const res = await request(app)
      .post("/api/v1/auth/totp/status")
      .set(bearer("PENDING_VENDOR", VENDOR_ID, "+919876000101"))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("authenticated CONSUMER may call totp/status", async () => {
    await request(app)
      .post("/api/v1/auth/totp/status")
      .set(bearer("CONSUMER", CONSUMER_ID))
      .expect(200);
  });

  it("accepts the httpOnly access cookie", async () => {
    const access = token("ADMIN", ADMIN_ID);
    await request(app)
      .get("/api/v1/admin/metrics")
      .set("Cookie", `snakzap_access=${access}`)
      .expect(200);
  });

  it("authenticate rejects suspended access on /me", async () => {
    const access = token("CONSUMER", CONSUMER_ID);
    await sharedIdentityRepo.suspend(CONSUMER_ID, "g2");
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${access}`)
      .expect(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("authenticate rejects deleted access on /me", async () => {
    const access = token("CONSUMER", CONSUMER_ID);
    sharedIdentityRepo._reset();
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${access}`)
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requireVendorOrAdmin lets VENDOR_OWNER past /api/vendor", async () => {
    const res = await request(app)
      .get("/api/vendor/orders")
      .set(bearer("VENDOR_OWNER", VENDOR_ID, "+919876000101"))
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requireVendorOrAdmin lets VENDOR_STAFF past /api/vendor", async () => {
    const res = await request(app)
      .get("/api/vendor/orders")
      .set(bearer("VENDOR_STAFF", VENDOR_ID, "+919876000101"))
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requireVendorOrAdmin lets ADMIN past /api/vendor", async () => {
    const res = await request(app)
      .get("/api/vendor/orders")
      .set(bearer("ADMIN", ADMIN_ID))
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requireVendorOrAdmin rejects CONSUMER on /api/vendor", async () => {
    const res = await request(app)
      .get("/api/vendor/orders")
      .set(bearer("CONSUMER", CONSUMER_ID))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a legacy refresh token without session_epoch", async () => {
    const refresh = jwt.sign(
      {
        phone: "+919876543210",
        role: "CONSUMER",
        device_fingerprint: FP,
        type: "refresh",
        jti: "legacy-refresh-jti",
      },
      REFRESH_SECRET,
      { subject: CONSUMER_ID, expiresIn: 86400, issuer: "snakzap" },
    );
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `snakzap_refresh=${refresh}`)
      .send({ device_fingerprint: FP })
      .expect(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});
