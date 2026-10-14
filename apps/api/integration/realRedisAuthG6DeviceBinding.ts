// ============================================================
// AUTH-G6 — Real-Redis cross-instance device-binding proof harness.
//
// NOT part of the memory-mode unit suite. Run explicitly with a real
// REDIS_URL. NODE_ENV=test is used deliberately so the identity repository
// stays in-memory (no PostgreSQL needed); the Redis client is overridden with
// a REAL ioredis connection via setRedisForTests, so session epochs and the
// refresh blacklist live in shared Redis across both app instances:
//
//   NODE_ENV=test \
//   REDIS_URL=redis://127.0.0.1:6379/12 \
//   pnpm exec tsx apps/api/integration/realRedisAuthG6DeviceBinding.ts
//
// Proves (and only claims):
//   - two independent app instances sharing ONE Redis agree on the
//     stateless HMAC device-binding cookie (process-independent)
//   - decoding the refresh token alone is insufficient: refresh without
//     the device cookie, with a forged signature, or with a wrong
//     uid/did binding all collapse to 401 DEVICE_MISMATCH
//   - logout bumps the session epoch in the shared Redis, so the other
//     instance rejects a valid, non-blacklisted pre-logout refresh token
//
// Does NOT claim: multi-node PostgreSQL behaviour, or defense against an
// attacker who has stolen the device cookie itself (that is a stolen-session
// problem, covered by logout/epoch revocation).
// ============================================================

import Redis from "ioredis";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { config } from "../src/config";
import { getRedis, setRedisForTests, type RedisLike } from "../src/lib/redis";
import { issueDeviceBindingCookie } from "../src/lib/deviceBinding";
import { sharedIdentityRepo } from "../src/repositories/shared";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("FATAL: REDIS_URL is required (point at a disposable redis db)");
  process.exit(2);
}

const ACCESS_COOKIE = config.jwt.accessCookieName;
const REFRESH_COOKIE = config.jwt.refreshCookieName;
const DEVICE_COOKIE = "snakzap_device";
const FP = "fp-auth-g6-realredis-0001";

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

function cookieValue(setCookie: string[] | undefined, name: string): string | null {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return header.split(";")[0]!.slice(`${name}=`.length);
}

function signedOut(setCookie: string[] | undefined, name: string): boolean {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!header) return false;
  return new RegExp(`${name}=;`).test(header) || /Expires=Thu, 01 Jan 1970/.test(header);
}

function didOf(deviceCookie: string): string {
  const payload = JSON.parse(
    Buffer.from(deviceCookie.split(".")[0]!, "base64url").toString("utf8"),
  ) as { did: string };
  return payload.did;
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

async function login(app: Express, phone: string): Promise<{
  access: string;
  refresh: string;
  device: string;
  deviceSetCookie: string;
  userId: string;
}> {
  const otpRes = await request(app).post("/api/v1/auth/send-otp").send({ phone });
  if (otpRes.status !== 200) throw new Error(`send-otp ${otpRes.status}`);
  const otp = otpRes.body.data.demoOtp as string;
  const res = await request(app)
    .post("/api/v1/auth/verify-otp")
    .send({ phone, otp, device_fingerprint: FP });
  if (res.status !== 200) throw new Error(`verify-otp ${res.status} ${JSON.stringify(res.body)}`);
  const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
  const refresh = cookieValue(cookies, REFRESH_COOKIE);
  const device = cookieValue(cookies, DEVICE_COOKIE);
  const deviceSetCookie = (cookies ?? []).find((c) => c.startsWith(`${DEVICE_COOKIE}=`)) ?? "";
  const user = await sharedIdentityRepo.getByPhone(phone);
  if (!refresh || !device || !user) throw new Error("login did not mint refresh+device cookies");
  return {
    access: res.body.data.access_token as string,
    refresh,
    device,
    deviceSetCookie,
    userId: user.id,
  };
}

async function main(): Promise<void> {
  const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: 1 });
  setRedisForTests(redis as unknown as RedisLike);
  check("getRedis() is the injected real client", getRedis() === (redis as unknown as RedisLike));
  check("real redis answers PING", (await redis.ping()) === "PONG");

  // Two independent app instances (separate route stacks, identical secret).
  const instanceA = createApp();
  const instanceB = createApp();

  const phone = `+9198${String(Date.now()).slice(-8)}`;
  const first = await login(instanceA, phone);

  // 0. The device cookie carries the required attributes on the wire.
  check(
    "device cookie is HttpOnly + SameSite=Strict + Path=/",
    /HttpOnly/i.test(first.deviceSetCookie) &&
      /SameSite=Strict/i.test(first.deviceSetCookie) &&
      /Path=\//.test(first.deviceSetCookie),
    first.deviceSetCookie,
  );
  check(
    "device cookie is not Secure outside production",
    !/;\s*Secure/i.test(first.deviceSetCookie),
    first.deviceSetCookie,
  );

  // 1. Cross-instance refresh: B accepts A's device cookie (stateless HMAC).
  const r1 = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${first.refresh}; ${DEVICE_COOKIE}=${first.device}`)
    .send({ device_fingerprint: FP });
  check(
    "cross-instance refresh with valid device cookie -> 200",
    r1.status === 200,
    `status=${r1.status} body=${JSON.stringify(r1.body)}`,
  );
  const r1Cookies = r1.headers["set-cookie"] as unknown as string[] | undefined;
  const r1Refresh = cookieValue(r1Cookies, REFRESH_COOKIE)!;
  const r1Device = cookieValue(r1Cookies, DEVICE_COOKIE)!;
  check("refresh re-issues the device cookie for the same device", !!r1Device);
  check(
    "refreshed device cookie keeps the same device id",
    !!r1Device && didOf(r1Device) === didOf(first.device),
  );

  // 2. Decode-the-token-alone is not enough: missing device cookie.
  const noCookie = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${r1Refresh}`)
    .send({ device_fingerprint: FP });
  check(
    "refresh without device cookie -> 401 DEVICE_MISMATCH",
    noCookie.status === 401 && noCookie.body?.error?.code === "DEVICE_MISMATCH",
    `status=${noCookie.status} code=${noCookie.body?.error?.code}`,
  );

  // 3. Forged signature.
  const tampered = `x${r1Device.slice(1)}`;
  const forged = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${r1Refresh}; ${DEVICE_COOKIE}=${tampered}`)
    .send({ device_fingerprint: FP });
  check(
    "refresh with forged device signature -> 401 DEVICE_MISMATCH",
    forged.status === 401 && forged.body?.error?.code === "DEVICE_MISMATCH",
    `status=${forged.status} code=${forged.body?.error?.code}`,
  );

  // 4. Wrong device id (same user, server-signed cookie for a different device).
  const wrongDid = issueDeviceBindingCookie(first.userId, "did-not-this-device");
  const didMismatch = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${r1Refresh}; ${DEVICE_COOKIE}=${wrongDid}`)
    .send({ device_fingerprint: FP });
  check(
    "refresh with mismatched device id -> 401 DEVICE_MISMATCH",
    didMismatch.status === 401 && didMismatch.body?.error?.code === "DEVICE_MISMATCH",
    `status=${didMismatch.status} code=${didMismatch.body?.error?.code}`,
  );

  // 5. Wrong user id (server-signed cookie bound to a different user).
  const wrongUid = issueDeviceBindingCookie("u-some-other-user", didOf(first.device));
  const uidMismatch = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${r1Refresh}; ${DEVICE_COOKIE}=${wrongUid}`)
    .send({ device_fingerprint: FP });
  check(
    "refresh with mismatched user id -> 401 DEVICE_MISMATCH",
    uidMismatch.status === 401 && uidMismatch.body?.error?.code === "DEVICE_MISMATCH",
    `status=${uidMismatch.status} code=${uidMismatch.body?.error?.code}`,
  );

  // 6. The JWT carries only the non-secret device_id, never the HMAC secret.
  const payload = jwtPayload(first.refresh);
  check("refresh JWT carries a non-secret device_id claim", typeof payload.device_id === "string");
  check(
    "refresh JWT does not embed the device-binding secret",
    !first.refresh.includes(config.deviceBinding.secret),
  );

  // 7. Logout on A (access cookie only) bumps the shared epoch WITHOUT
  //    blacklisting r1, so the next check isolates the epoch across instances.
  const logout = await request(instanceA)
    .post("/api/v1/auth/logout")
    .set("Origin", "http://localhost:3000")
    .set("Cookie", `${ACCESS_COOKIE}=${first.access}`);
  const logoutCookies = logout.headers["set-cookie"] as unknown as string[] | undefined;
  check(
    "logout clears the device cookie",
    signedOut(logoutCookies, DEVICE_COOKIE),
    `status=${logout.status} set-cookie=${JSON.stringify(logoutCookies)} body=${JSON.stringify(logout.body)}`,
  );

  const me = await request(instanceB)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${first.access}`);
  check(
    "stale access on the other instance -> 401 SESSION_REVOKED",
    me.status === 401 && me.body?.error?.code === "SESSION_REVOKED",
    `status=${me.status} code=${me.body?.error?.code}`,
  );

  const staleRefresh = await request(instanceB)
    .post("/api/v1/auth/refresh")
    .set("Cookie", `${REFRESH_COOKIE}=${r1Refresh}; ${DEVICE_COOKIE}=${r1Device}`)
    .send({ device_fingerprint: FP });
  check(
    "valid non-blacklisted pre-logout refresh -> 401 SESSION_REVOKED (epoch)",
    staleRefresh.status === 401 && staleRefresh.body?.error?.code === "SESSION_REVOKED",
    `status=${staleRefresh.status} code=${staleRefresh.body?.error?.code}`,
  );

  await redis.quit();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAUTH-G6 REAL-REDIS: ALL PASS" : `\nAUTH-G6 REAL-REDIS: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("HARNESS ERROR:", err);
    process.exit(1);
  });
