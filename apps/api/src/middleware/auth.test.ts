import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";

describe("Auth middleware", () => {
  let app: Express;

  const deviceFp = "fp_test_device_abc1234";
  const claims = {
    sub: "u00000000-0000-4000-8000-000000000001",
    phone: "+919876543210",
    role: "CONSUMER",
    device_fingerprint: deviceFp,
  };

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  it("returns 401 when Authorization header is missing from POST /orders", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when Authorization header is missing from POST /orders/reorder", async () => {
    const res = await request(app)
      .post("/api/v1/orders/reorder")
      .send({ old_order_id: "00000000-0000-4000-8000-000000000099" })
      .expect(401);

    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with malformed Authorization header (not Bearer)", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", "Basic dGVzdDp0ZXN0")
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(401);

    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with an invalid/random token", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", "Bearer this-is-not-a-jwt")
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(401);

    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 with an expired access token", async () => {
    const jwt = await import("jsonwebtoken");
    const { sub, ...rest } = { ...claims, type: "access", jti: "expired-jti" };
    const expiredToken = jwt.default.sign(
      rest,
      process.env.JWT_SECRET ?? "test-access-secret-at-least-32-characters-long",
      {
        subject: sub,
        expiresIn: "-1s",
        issuer: "snakzap",
      },
    );

    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${expiredToken}`)
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(401);

    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("allows order creation with a valid access token and uses JWT user_id", async () => {
    const token = jwtService.signAccessToken(claims);

    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${token}`)
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 2,
            customizations: [],
          },
        ],
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user_id).toBe(claims.sub);
    expect(res.body.data.status).toBe("DRAFT");
  });

  it("rejects a refresh token used as an access token (type mismatch)", async () => {
    const { token: refreshToken } = jwtService.signRefreshToken(claims);

    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${refreshToken}`)
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000001",
        items: [
          {
            menu_item_id: "b0000000-0000-4000-8000-000000000001",
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(401);

    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});
