import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { sharedOrderRepo } from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// D04 Hyperlocal Heatmap - GET /api/v1/discovery/heatmap
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001"; // Biryani House 19.076, 72.8777
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002"; // Green Bowl 19.1136, 72.8697

function seedOrder(
  id: string,
  restaurantId: string,
  createdAt: string,
  status: OrderDTO["status"] = "CONFIRMED",
): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: "00000000-0000-4000-8000-0000000000a1",
    restaurant_id: restaurantId,
    items: [],
    total_amount: 220,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

const nowIso = () => new Date().toISOString();
const insideWindow = (minsBack: number) =>
  new Date(Date.now() - minsBack * 60_000).toISOString();

describe("D04 Hyperlocal Heatmap", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    app = createApp();
  });

  it("returns an empty, lightweight grid when there are no orders", async () => {
    const res = await request(app).get("/api/v1/discovery/heatmap").expect(200);
    expect(res.body.data).toMatchObject({
      window_minutes: 30,
      total_orders: 0,
      cells: [],
    });
    expect(JSON.stringify(res.body.data).length).toBeLessThan(500);
  });

  it("buckets recent orders per outlet and counts density", async () => {
    seedOrder("h1", REST_ID, nowIso());
    seedOrder("h2", REST_ID, nowIso());
    seedOrder("h3", REST_ID, insideWindow(5));
    seedOrder("h4", GREEN_BOWL_ID, nowIso());

    const res = await request(app).get("/api/v1/discovery/heatmap").expect(200);
    const d = res.body.data;
    expect(d.window_minutes).toBe(30);
    expect(d.total_orders).toBe(4);

    const biryani = d.cells.find((c: { lng: number }) => c.lng === 72.878);
    const green = d.cells.find((c: { lng: number }) => c.lng === 72.87);
    expect(biryani).toMatchObject({ lat: 19.076, lng: 72.878, count: 3 });
    expect(green).toMatchObject({ lat: 19.114, lng: 72.87, count: 1 });

    // sorted by count desc
    expect(d.cells[0].count).toBeGreaterThanOrEqual(d.cells[1].count);
  });

  it("excludes abandoned / failed / cancelled statuses", async () => {
    seedOrder("h1", REST_ID, nowIso(), "DRAFT");
    seedOrder("h2", REST_ID, nowIso(), "PAYMENT_FAILED");
    seedOrder("h3", REST_ID, nowIso(), "CANCELLED");
    seedOrder("h4", REST_ID, nowIso(), "PICKED_UP");

    const res = await request(app).get("/api/v1/discovery/heatmap").expect(200);
    expect(res.body.data.total_orders).toBe(1);
    expect(res.body.data.cells).toHaveLength(1);
    expect(res.body.data.cells[0].count).toBe(1);
  });

  it("excludes orders older than the 30-minute window", async () => {
    seedOrder("old1", REST_ID, insideWindow(31));
    seedOrder("old2", GREEN_BOWL_ID, insideWindow(45));
    seedOrder("fresh", REST_ID, nowIso());

    const res = await request(app).get("/api/v1/discovery/heatmap").expect(200);
    expect(res.body.data.total_orders).toBe(1);
    expect(res.body.data.cells).toHaveLength(1);
  });
});
