import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";

describe("General API rate limit (100 req/min/IP)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    app = createApp();
  });

  it("allows up to 100 requests then returns 429", async () => {
    for (let i = 0; i < 100; i++) {
      await request(app)
        .post("/api/v1/auth/refresh")
        .send({ device_fingerprint: "fp-x-1234567890" })
        .expect((res) => {
          if (res.status === 429) {
            throw new Error(`Unexpected 429 at request ${i + 1}`);
          }
        });
    }
    const blocked = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ device_fingerprint: "fp-x-1234567890" })
      .expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
