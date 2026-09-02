import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";

describe("Pickup Slots API", () => {
  const app = createApp();
  const REST_ID = "a0000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    // Deterministic clock: only Date is faked; real timers stay untouched so
    // supertest/express keep working. This removes the time-of-day flake.
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setUtcClock(iso: string) {
    vi.setSystemTime(new Date(iso));
  }

  it("GET /restaurants/:id/pickup-slots returns 15-minute slots (normal hour)", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
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
    setUtcClock("2026-08-24T12:00:00.000Z");
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

  it("does not fabricate a past slot (first slot is at least next hour)", async () => {
    setUtcClock("2026-08-24T14:00:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    expect(res.body.data.slots.length).toBeGreaterThan(0);
    const first = res.body.data.slots[0].time;
    const firstHour = Number(first.slice(0, 2));
    // At 14:00 UTC startHour = max(14+1, 8) = 15, so first slot must be >= 15:00.
    expect(firstHour).toBeGreaterThanOrEqual(15);
  });

  it("returns an empty list late in the day when the pickup window has closed (22:30)", async () => {
    setUtcClock("2026-08-24T22:30:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    // Contract: an empty list is legitimate once the day's service window
    // has ended (startHour = max(22+1, 8) = 23 = endHour -> no slots).
    expect(res.body.success).toBe(true);
    expect(res.body.data.slots).toEqual([]);
  });

  it("returns an empty list late in the day when the pickup window has closed (23:30)", async () => {
    setUtcClock("2026-08-24T23:30:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: today })
      .expect(200);

    // Contract: startHour = max(23+1, 8) = 24 >= endHour(23) -> empty list.
    expect(res.body.success).toBe(true);
    expect(res.body.data.slots).toEqual([]);
  });

  it("returns a full 08:00-22:45 window for a future date (unchanged)", async () => {
    setUtcClock("2026-08-24T23:30:00.000Z");
    const future = "2026-08-25";
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: future })
      .expect(200);

    // Future-date behavior unchanged: startHour = 8, endHour = 23.
    const hours = 15; // 8..22 inclusive
    expect(res.body.data.slots).toHaveLength(hours * 4);
    expect(res.body.data.slots[0].time).toBe("08:00");
    expect(res.body.data.slots[res.body.data.slots.length - 1].time).toBe("22:45");
  });

  it("returns 404 for inactive restaurant", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get("/api/v1/restaurants/a0000000-0000-4000-8000-000000000003/pickup-slots")
      .query({ date: today })
      .expect(404);

    expect(res.body.error.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("returns 400 for invalid date format", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const res = await request(app)
      .get(`/api/v1/restaurants/${REST_ID}/pickup-slots`)
      .query({ date: "not-a-date" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("ordered slots are chronological", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
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
