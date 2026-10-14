import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { config } from "../config";
import { getRedis, MemoryRedis, resetRedisForTests, setRedisForTests } from "../lib/redis";
import {
  getSessionEpoch,
  incrementSessionEpoch,
  parseEpochClaim,
  parseStoredEpoch,
  sessionEpochKey,
} from "../lib/sessionEpoch";
import { AppError } from "../middleware/envelope";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";
import { _authG2TestHooks } from "./auth";

const PHONE = "+919876000080";
const FP = "fp-auth-g2-0000000001";
const ACCESS_COOKIE = config.jwt.accessCookieName;
const REFRESH_COOKIE = config.jwt.refreshCookieName;
const DEVICE_COOKIE = "snakzap_device";
const ACCESS_SECRET =
  process.env.JWT_SECRET ?? "test-access-secret-at-least-32-characters-long";

describe("AUTH-G2 session epoch, logout, refresh race", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedIdentityRepo._reset();
    _authG2TestHooks.afterRefreshEpochValidated = async () => {};
    app = createApp();
  });

  afterEach(() => {
    _authG2TestHooks.afterRefreshEpochValidated = async () => {};
  });

  async function login(
    phone = PHONE,
  ): Promise<{ access: string; refresh: string; device: string; userId: string }> {
    const otpRes = await request(app)
      .post("/api/v1/auth/send-otp")
      .send({ phone })
      .expect(200);
    const otp = otpRes.body.data.demoOtp as string;
    const res = await request(app)
      .post("/api/v1/auth/verify-otp")
      .send({ phone, otp, device_fingerprint: FP })
      .expect(200);
    const cookies = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
    const refreshHeader = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    const accessHeader = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
    const deviceHeader = cookies.find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
    expect(refreshHeader).toBeDefined();
    expect(deviceHeader).toBeDefined();
    const refresh = refreshHeader!.split(";")[0]!.slice(`${REFRESH_COOKIE}=`.length);
    const device = deviceHeader!.split(";")[0]!.slice(`${DEVICE_COOKIE}=`.length);
    const access =
      accessHeader?.split(";")[0]!.slice(`${ACCESS_COOKIE}=`.length) ??
      (res.body.data.access_token as string);
    const user = await sharedIdentityRepo.getByPhone(phone);
    expect(user).not.toBeNull();
    return { access, refresh, device, userId: user!.id };
  }

  function refreshCookieHeader(refresh: string, device: string): string {
    return `${REFRESH_COOKIE}=${refresh}; ${DEVICE_COOKIE}=${device}`;
  }

  it("missing epoch key means zero", async () => {
    expect(await getSessionEpoch("missing-user")).toBe(0);
    expect(parseStoredEpoch(null)).toBe(0);
  });

  it("increment is Redis INCR from missing key to 1", async () => {
    expect(await incrementSessionEpoch("u-incr-1")).toBe(1);
    expect(await getRedis().get(sessionEpochKey("u-incr-1"))).toBe("1");
  });

  it("increment is atomic across sequential bumps", async () => {
    await incrementSessionEpoch("u-incr-2");
    await incrementSessionEpoch("u-incr-2");
    expect(await getSessionEpoch("u-incr-2")).toBe(2);
  });

  it("stored epoch 0 and 1 are valid", () => {
    expect(parseStoredEpoch("0")).toBe(0);
    expect(parseStoredEpoch("1")).toBe(1);
  });

  it("malformed stored epoch 1abc is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-1abc"), "1abc");
    await expect(getSessionEpoch("u-bad-1abc")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(incrementSessionEpoch("u-bad-1abc")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("malformed stored epoch 1.5 is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-1.5"), "1.5");
    await expect(getSessionEpoch("u-bad-1.5")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(incrementSessionEpoch("u-bad-1.5")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("malformed stored epoch -1 is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-neg"), "-1");
    await expect(getSessionEpoch("u-bad-neg")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("malformed stored epoch leading zero is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-lz"), "01");
    await expect(getSessionEpoch("u-bad-lz")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("malformed stored epoch unsafe integer is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-unsafe"), "9007199254740992");
    await expect(getSessionEpoch("u-bad-unsafe")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("malformed stored epoch whitespace is SERVICE_UNAVAILABLE", async () => {
    await getRedis().set(sessionEpochKey("u-bad-ws"), " 1");
    await expect(getSessionEpoch("u-bad-ws")).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("Redis read failure is SERVICE_UNAVAILABLE", async () => {
    const failing = new MemoryRedis();
    failing.get = async () => {
      throw new Error("redis_down");
    };
    setRedisForTests(failing);
    try {
      await expect(getSessionEpoch("u-redis-get")).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    } finally {
      resetRedisForTests();
    }
  });

  it("Redis incr failure is SERVICE_UNAVAILABLE", async () => {
    const failing = new MemoryRedis();
    failing.incr = async () => {
      throw new Error("redis_incr_down");
    };
    setRedisForTests(failing);
    try {
      await expect(incrementSessionEpoch("u-redis-incr")).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    } finally {
      resetRedisForTests();
    }
  });

  it("parseEpochClaim rejects missing and non-integers as INVALID_TOKEN", () => {
    for (const bad of ["0", -1, 1.5, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        parseEpochClaim(bad);
        throw new Error("expected INVALID_TOKEN");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({ code: "INVALID_TOKEN", status: 401 });
      }
    }
    expect(parseEpochClaim(0)).toBe(0);
    expect(parseEpochClaim(1)).toBe(1);
  });

  it("access and refresh tokens carry session_epoch 0 at first login", async () => {
    const { access, refresh } = await login();
    expect(jwtService.verifyAccessToken(access).session_epoch).toBe(0);
    expect(jwtService.verifyRefreshToken(refresh).session_epoch).toBe(0);
  });

  it("issuePair stamps the current redis epoch", async () => {
    const userId = "u-stamp-epoch-0000000001";
    await incrementSessionEpoch(userId);
    const pair = await jwtService.issuePair({
      sub: userId,
      phone: PHONE,
      role: "CONSUMER",
      device_fingerprint: FP,
    });
    expect(jwtService.verifyAccessToken(pair.accessToken).session_epoch).toBe(1);
    expect(jwtService.verifyRefreshToken(pair.refreshToken).session_epoch).toBe(1);
  });

  it("logout with access only bumps once", async () => {
    const { access, userId } = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
  });

  it("logout with refresh only bumps once", async () => {
    const { refresh, userId } = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
  });

  it("logout with access plus refresh bumps once", async () => {
    const { access, refresh, userId } = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Origin", "http://localhost:3000")
      .set("Cookie", `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
  });

  it("stale refresh logout does not bump", async () => {
    const { refresh, userId } = await login();
    await incrementSessionEpoch(userId);
    expect(await getSessionEpoch(userId)).toBe(1);
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
  });

  it("stale access logout does not bump", async () => {
    const { access, userId } = await login();
    await incrementSessionEpoch(userId);
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
  });

  it("logout without credentials is idempotent", async () => {
    const res = await request(app).post("/api/v1/auth/logout").expect(200);
    expect(res.body.data.logged_out).toBe(true);
  });

  it("refresh preserves the validated epoch on mint", async () => {
    const { refresh, device, userId } = await login();
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(200);
    expect(jwtService.verifyAccessToken(res.body.data.access_token).session_epoch).toBe(0);
    expect(await getSessionEpoch(userId)).toBe(0);
  });

  it("refresh after logout is rejected as revoked", async () => {
    const { refresh, device } = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(401);
    expect(["SESSION_REVOKED", "REFRESH_TOKEN_REUSED"]).toContain(res.body.error.code);
  });

  it("access after logout is SESSION_REVOKED", async () => {
    const { access } = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${access}`)
      .expect(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("login after logout mints the post-logout epoch", async () => {
    const first = await login();
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE}=${first.refresh}`)
      .expect(200);
    await getRedis().del(`rl:otp:${PHONE}`);
    const second = await login();
    expect(jwtService.verifyAccessToken(second.access).session_epoch).toBe(1);
    expect(second.userId).toBe(first.userId);
  });

  it("inflight refresh cannot inherit a post-logout epoch", async () => {
    const { refresh, device, userId } = await login();
    _authG2TestHooks.afterRefreshEpochValidated = async (id) => {
      await incrementSessionEpoch(id);
    };
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(200);
    expect(await getSessionEpoch(userId)).toBe(1);
    const mintedAccess = res.body.data.access_token as string;
    expect(jwtService.verifyAccessToken(mintedAccess).session_epoch).toBe(0);
    const denied = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${mintedAccess}`)
      .expect(401);
    expect(denied.body.error.code).toBe("SESSION_REVOKED");
  });

  it("concurrent logout makes the inflight refresh pair stale", async () => {
    const { access, refresh, device, userId } = await login();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    _authG2TestHooks.afterRefreshEpochValidated = async () => {
      entered();
      await gate;
    };

    const refreshP = request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP });
    const refreshResult = Promise.resolve(refreshP);
    await started;
    await request(app)
      .post("/api/v1/auth/logout")
      .set("Origin", "http://localhost:3000")
      .set("Cookie", `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`)
      .expect(200);
    release();
    const res = await refreshResult;
    expect(res.status).toBe(200);
    expect(await getSessionEpoch(userId)).toBe(1);

    const mintedAccess = res.body.data.access_token as string;
    const mintedRefreshHeader = (
      (res.headers["set-cookie"] as unknown as string[] | undefined) ?? []
    ).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    expect(mintedRefreshHeader).toBeDefined();
    const mintedRefresh = mintedRefreshHeader!
      .split(";")[0]!
      .slice(`${REFRESH_COOKIE}=`.length);

    expect(jwtService.verifyAccessToken(mintedAccess).session_epoch).toBe(0);
    expect(jwtService.verifyRefreshToken(mintedRefresh).session_epoch).toBe(0);

    const accessDenied = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${mintedAccess}`)
      .expect(401);
    expect(accessDenied.body.error.code).toBe("SESSION_REVOKED");

    const refreshDenied = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(mintedRefresh, device))
      .send({ device_fingerprint: FP })
      .expect(401);
    expect(refreshDenied.body.error.code).toBe("SESSION_REVOKED");
  });

  it("refresh reuse detection is preserved", async () => {
    const { refresh, device } = await login();
    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(200);
    const reused = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(401);
    expect(reused.body.error.code).toBe("REFRESH_TOKEN_REUSED");
  });

  it("refresh without the device binding cookie is DEVICE_MISMATCH", async () => {
    const { refresh } = await login();
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${refresh}`)
      .send({ device_fingerprint: "fp-other-device-xx" })
      .expect(401);
    expect(res.body.error.code).toBe("DEVICE_MISMATCH");
  });

  it("refresh re-reads the current DB role", async () => {
    const { refresh, device, userId } = await login();
    await sharedIdentityRepo.updateRole(userId, "VENDOR_OWNER");
    const res = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", refreshCookieHeader(refresh, device))
      .send({ device_fingerprint: FP })
      .expect(200);
    expect(jwtService.verifyAccessToken(res.body.data.access_token).role).toBe(
      "VENDOR_OWNER",
    );
  });

  it("TOTP tickets do not require session_epoch", () => {
    const ticket = jwtService.signTotpTicket({
      sub: "u-totp-epoch-00000000001",
      phone: PHONE,
      role: "CONSUMER",
      device_fingerprint: FP,
    });
    expect(jwtService.verifyTotpTicket(ticket).type).toBe("totp_ticket");
    expect(jwtService.verifyTotpTicket(ticket).session_epoch).toBeUndefined();
  });

  it("legacy access without epoch is rejected by verifyAccessToken", () => {
    const legacy = jwt.sign(
      {
        phone: PHONE,
        role: "CONSUMER",
        device_fingerprint: FP,
        type: "access",
        jti: "legacy",
      },
      ACCESS_SECRET,
      { subject: "u-legacy", expiresIn: 900, issuer: "snakzap" },
    );
    expect(() => jwtService.verifyAccessToken(legacy)).toThrow(AppError);
  });

  it("session epoch key is redis-backed per user", async () => {
    expect(sessionEpochKey("abc")).toBe("auth:session_epoch:abc");
    await incrementSessionEpoch("abc");
    expect(await getRedis().get("auth:session_epoch:abc")).toBe("1");
  });

  it("JWT signing does not mutate identity even in NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    jwtService.signAccessToken({
      sub: "u-fixture-only-0000000001",
      phone: "+919876000081",
      role: "CONSUMER",
      device_fingerprint: FP,
    });
    expect(await sharedIdentityRepo.getById("u-fixture-only-0000000001")).toBeNull();
  });
});
