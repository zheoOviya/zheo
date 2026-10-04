import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("CORS policy", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp();
  });

  it("CORS-1 exact configured origin gets ACAO + credentialed grant", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("CORS-2 unlisted origin receives no credentialed CORS grant", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS-3 former wildcard subdomain is rejected unless explicitly listed", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://3100-abc123.monkeycode-ai.live");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS-4 malformed Origin is rejected", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "not-a-valid-origin");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS-5 no-Origin request does not invent an ACAO origin", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
