import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("CORS policy", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  it("allows an exact-match origin from the allowlist", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("allows any subdomain of the configured wildcard host", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://3100-abc123.monkeycode-ai.live");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://3100-abc123.monkeycode-ai.live",
    );
  });

  it("rejects unknown origins (no Access-Control-Allow-Origin header)", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows requests without an Origin header", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
