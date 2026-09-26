import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import {
  RATE_WINDOW_MS,
  getRatePerMinute,
  getRateWindowSize,
  metrics,
  recordCompletedRequest,
  resetMetricsForTests,
} from "./metrics";

function parseMetric(body: string, name: string): number {
  const match = body.match(new RegExp(`^${name} (.+)$`, "m"));
  if (!match) throw new Error(`Metric ${name} not found in:\n${body}`);
  return Number(match[1]);
}

describe("observability metrics (/metrics)", () => {
  describe("snakzap_http_rate_per_minute trailing 60s window", () => {
    beforeEach(() => {
      resetMetricsForTests();
    });

    it("R1: reports 0 when no requests have completed", () => {
      expect(getRatePerMinute()).toBe(0);
    });

    it("R2: counts all completions inside the window", () => {
      const t = 1_000_000;
      recordCompletedRequest(t);
      recordCompletedRequest(t + 1);
      recordCompletedRequest(t + 2);
      expect(getRatePerMinute(t + 3)).toBe(3);
    });

    it("R3: excludes completions older than the window", () => {
      const t = 1_000_000;
      recordCompletedRequest(t);
      recordCompletedRequest(t + RATE_WINDOW_MS + 1);
      expect(getRatePerMinute(t + RATE_WINDOW_MS + 1)).toBe(1);
    });

    it("R4: prunes a completion exactly at the 60s boundary", () => {
      const t = 1_000_000;
      recordCompletedRequest(t);
      expect(getRatePerMinute(t + RATE_WINDOW_MS - 1)).toBe(1);
      expect(getRatePerMinute(t + RATE_WINDOW_MS)).toBe(0);
    });

    it("R8: keeps retained storage bounded under a long burst", () => {
      const t = 1_000_000;
      for (let i = 0; i < 10_000; i++) {
        recordCompletedRequest(t + i);
      }
      // A 10k burst spans <60s, so all are retained until the window moves on.
      expect(getRatePerMinute(t + 9_999)).toBe(10_000);
      expect(getRatePerMinute(t + RATE_WINDOW_MS + 10_000)).toBe(0);
      expect(getRateWindowSize()).toBe(0);
    });
  });

  describe("cumulative counters", () => {
    let app: Express;

    beforeEach(() => {
      resetRedisForTests();
      resetMetricsForTests();
      app = createApp();
    });

    it("R5: requests_total stays lifetime cumulative", async () => {
      await request(app).get("/metrics").expect(200);
      await request(app).get("/metrics").expect(200);
      await request(app).get("/metrics").expect(200);
      const res = await request(app).get("/metrics").expect(200);
      expect(parseMetric(res.text, "snakzap_http_requests_total")).toBe(3);
    });

    it("R6: duration_avg_seconds stays the mean duration", async () => {
      metrics.requests = 4;
      metrics.totalDurationMs = 800;
      const res = await request(app).get("/metrics").expect(200);
      expect(
        parseMetric(res.text, "snakzap_http_duration_avg_seconds"),
      ).toBeCloseTo(0.2, 4);
      // The reading scrape is only counted after its own response finishes.
      expect(parseMetric(res.text, "snakzap_http_requests_total")).toBe(4);
    });

    it("R7: errors_total still counts responses with status >= 400", async () => {
      await request(app).get("/definitely-not-a-route").expect(404);
      await request(app).get("/metrics").expect(200);
      const res = await request(app).get("/metrics").expect(200);
      expect(parseMetric(res.text, "snakzap_http_errors_total")).toBe(1);
      expect(parseMetric(res.text, "snakzap_http_requests_total")).toBe(2);
    });

    it("R2-integration: endpoint rate reflects completed requests in-window", async () => {
      await request(app).get("/metrics").expect(200);
      await request(app).get("/metrics").expect(200);
      await request(app).get("/metrics").expect(200);
      const res = await request(app).get("/metrics").expect(200);
      expect(parseMetric(res.text, "snakzap_http_rate_per_minute")).toBe(3);
      expect(parseMetric(res.text, "snakzap_http_requests_total")).toBe(3);
    });
  });
});
