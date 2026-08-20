import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";

describe("Gift routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedGiftRepo._reset();
    sharedPaymentRepo._reset();
    resetCatalogRepository();
    app = createApp();
  });

  describe("POST /api/v1/gifts", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app)
        .post("/api/v1/gifts")
        .set("Content-Type", "application/json")
        .send({});
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/gifts/t/:token", () => {
    it("returns 404 for an unknown token", async () => {
      const res = await request(app).get("/api/v1/gifts/t/nope");
      expect(res.status).toBe(404);
    });
  });
});
