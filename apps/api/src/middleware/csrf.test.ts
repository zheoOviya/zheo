import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { config } from "../config";
import { resetRedisForTests } from "../lib/redis";
import { sharedOrderRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";

const ALLOWED_ORIGIN = "http://localhost:3000";
const HOSTILE_ORIGIN = "https://evil.example.com";
const ACCESS_COOKIE = config.jwt.accessCookieName;
const REFRESH_COOKIE = config.jwt.refreshCookieName;

const claims = {
  sub: "u00000000-0000-4000-8000-000000000001",
  phone: "+919876543210",
  role: "CONSUMER",
  device_fingerprint: "fp_test_device_abc1234",
};

const ORDER_BODY = {
  restaurant_id: "a0000000-0000-4000-8000-000000000001",
  items: [
    {
      menu_item_id: "b0000000-0000-4000-8000-000000000001",
      quantity: 1,
      customizations: [],
    },
  ],
};

function accessCookieHeader(token: string): string {
  return `${ACCESS_COOKIE}=${token}`;
}

describe("Origin CSRF gate (cookie-authenticated unsafe methods)", () => {
  let app: Express;
  let token: string;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    app = createApp();
    token = jwtService.signAccessToken(claims);
  });

  it("CSRF-1 cookie-auth POST + exact allowed Origin passes the CSRF boundary", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .set("Origin", ALLOWED_ORIGIN)
      .send(ORDER_BODY)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user_id).toBe(claims.sub);
  });

  it("CSRF-2 cookie-auth POST + hostile Origin is 403 before handler mutation", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .set("Origin", HOSTILE_ORIGIN)
      .send(ORDER_BODY)
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toContain(ACCESS_COOKIE);

    const listed = await request(app)
      .get("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .expect(200);
    expect(listed.body.data.orders).toEqual([]);
  });

  it("CSRF-3 cookie-auth POST + missing Origin is 403 before handler mutation", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .send(ORDER_BODY)
      .expect(403);

    expect(res.body.error.code).toBe("FORBIDDEN");

    const listed = await request(app)
      .get("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .expect(200);
    expect(listed.body.data.orders).toEqual([]);
  });

  it("CSRF-4 cookie-auth PUT/PATCH/DELETE get the same Origin protection", async () => {
    const put = await request(app)
      .put("/api/v1/users/profile")
      .set("Cookie", accessCookieHeader(token))
      .set("Origin", HOSTILE_ORIGIN)
      .send({ spice_tolerance: 2 })
      .expect(403);
    expect(put.body.error.code).toBe("FORBIDDEN");

    const patch = await request(app)
      .patch("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .send({ noop: true })
      .expect(403);
    expect(patch.body.error.code).toBe("FORBIDDEN");

    const del = await request(app)
      .delete("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .set("Origin", HOSTILE_ORIGIN)
      .expect(403);
    expect(del.body.error.code).toBe("FORBIDDEN");
  });

  it("CSRF-5 cookie-auth GET/HEAD are not blocked", async () => {
    const getRes = await request(app)
      .get("/api/v1/orders")
      .set("Cookie", accessCookieHeader(token))
      .expect(200);
    expect(getRes.body.success).toBe(true);

    const headRes = await request(app)
      .head("/health")
      .set("Cookie", accessCookieHeader(token));
    expect(headRes.status).toBe(200);
  });

  it("CSRF-6 Bearer-only unsafe request with no cookie and no Origin is not blocked", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${token}`)
      .send(ORDER_BODY)
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user_id).toBe(claims.sub);
  });

  it("CSRF-7 signed webhook without access cookie is not intercepted as CSRF", async () => {
    const res = await request(app)
      .post("/api/v1/payments/webhook")
      .set("Content-Type", "application/json")
      .send({ event: "payment.captured" });

    expect(res.status).not.toBe(403);
    expect(res.body.error?.code).not.toBe("FORBIDDEN");
    expect(res.body.error?.code).toBe("MISSING_SIGNATURE");
    expect(res.status).toBe(401);
  });

  it("CSRF-8 preflight OPTIONS is not blocked", async () => {
    const res = await request(app)
      .options("/api/v1/orders")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).not.toBe(403);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);
  });

  it("keys on the configured access-cookie name, not arbitrary cookies", async () => {
    const refreshOnly = await request(app)
      .post("/api/v1/orders")
      .set("Cookie", `${REFRESH_COOKIE}=not-an-access-token; other_cookie=abc`)
      .send(ORDER_BODY);

    expect(refreshOnly.status).toBe(401);
    expect(refreshOnly.body.error.code).toBe("UNAUTHORIZED");

    const accessNamed = await request(app)
      .post("/api/v1/orders")
      .set("Cookie", accessCookieHeader("garbage-token"))
      .send(ORDER_BODY)
      .expect(403);
    expect(accessNamed.body.error.code).toBe("FORBIDDEN");
  });
});
