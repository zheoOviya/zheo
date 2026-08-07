import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";

describe("Pickup Slots API", () => {
  const app = createApp();
  const REST_ID = "a0000000-0000-4000-8000-000000000001";

  it("GET /restaurants/:id/pickup-slots returns 15-minute slots", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data.restaurant_id).toBe(REST_ID);
    expect(res.body.data.date).toBe(today);
    expect(Array.isArray(res.body.data.slots)).toBe(true);
    expect(res.body.data.slots.length).toBeGreaterThan(0);
  });

  it("each slot has correct shape", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    const slot = res.body.data.slots[0];
    expect(slot).toHaveProperty("time");
    expect(slot).toHaveProperty("label");
    expect(slot).toHaveProperty("available");
    expect(slot).toHaveProperty("current_orders");
    expect(slot).toHaveProperty("max_capacity");
    expect(slot.max_capacity).toBe(10);
    expect(typeof slot.available).toBe("boolean");
    expect(typeof slot.current_orders).toBe("number");
    expect(slot.current_orders).toBeGreaterThanOrEqual(0);
    expect(slot.current_orders).toBeLessThanOrEqual(10);
  });

  it("returns 404 for inactive restaurant", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get("/api/v1/restaurants/a0000000-0000-4000-8000-000000000003/pickup-slots")
      .query({ date: today })
      .expect(404);

    expect(res.body.error.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("returns 400 for invalid date format", async () => {
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: "not-a-date" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("ordered slots are chronological", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    const times = res.body.data.slots.map((s: { time: string }) => s.time);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });
});
