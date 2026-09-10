import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiEnvelopeSchema, type OrderStatus } from "@snakzap/types";
import { createApp } from "../app";
import { config } from "../config";
import { sharedOrderRepo } from "../repositories/shared";
import type { PickupSlotDTO } from "../services/pickupSlots";

// Pickup-slot truth (PICKUP-SLOT-TRUTH-A2). Availability is the deterministic
// count of persisted qualifying orders per IST 15-minute bucket versus the
// configured PICKUP_SLOT_CAPACITY. These tests pin that contract and guard
// against any return of the old Math.random()/hardcoded-capacity fabrication.

type MutablePickupConfig = { capacity: number | null };

function setCapacity(value: number | null): void {
  (config.pickupSlots as MutablePickupConfig).capacity = value;
}

/** UTC instant for an IST wall-clock date/time (offset is explicit). */
function istInstant(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+05:30`).toISOString();
}

describe("Pickup Slots API", () => {
  const app = createApp();
  const REST_ID = "a0000000-0000-4000-8000-000000000001";
  const INACTIVE_ID = "a0000000-0000-4000-8000-000000000003";
  const TODAY = "2026-08-24";
  const TOMORROW = "2026-08-25";

  let seq = 0;

  beforeEach(() => {
    // Deterministic clock: only Date is faked; real timers stay untouched so
    // supertest/express keep working. This removes the time-of-day flake.
    vi.useFakeTimers({ toFake: ["Date"] });
    sharedOrderRepo._reset();
    seq = 0;
    setCapacity(3);
  });

  afterEach(() => {
    vi.useRealTimers();
    setCapacity(null);
  });

  function setUtcClock(iso: string) {
    vi.setSystemTime(new Date(iso));
  }

  function seedScheduled(iso: string | null, status: OrderStatus): void {
    seq += 1;
    sharedOrderRepo._seed({
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      user_id: "u-1",
      restaurant_id: REST_ID,
      items: [],
      total_amount: 100,
      status,
      commission_rate: 0.08,
      commission_amount: 8,
      pickup_otp: null,
      qr_token: null,
      checked_in: false,
      scheduled_pickup_time: iso,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
    });
  }

  function fetchSlots(date: string, restaurantId = REST_ID) {
    return request(app)
      .get(`/api/v1/restaurants/${restaurantId}/pickup-slots`)
      .query({ date });
  }

  function findSlot(slots: PickupSlotDTO[], time: string): PickupSlotDTO {
    const slot = slots.find((s) => s.time === time);
    if (!slot) throw new Error(`slot ${time} not found`);
    return slot;
  }

  it("returns 15-minute slots with the configured capacity", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z"); // 17:30 IST
    const res = await fetchSlots(TODAY).expect(200);

    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    expect(res.body.data.restaurant_id).toBe(REST_ID);
    expect(res.body.data.date).toBe(TODAY);
    expect(Array.isArray(res.body.data.slots)).toBe(true);
    expect(res.body.data.slots.length).toBeGreaterThan(0);

    const slot = res.body.data.slots[0];
    expect(slot).toMatchObject({
      time: expect.any(String),
      label: expect.any(String),
      available: expect.any(Boolean),
      current_orders: expect.any(Number),
      max_capacity: 3,
    });
    expect(slot.available).toBe(true);
    expect(slot.current_orders).toBe(0);
  });

  it("returns the configured capacity as max_capacity for every slot", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    setCapacity(7);
    const res = await fetchSlots(TOMORROW).expect(200);
    expect(res.body.data.slots.length).toBeGreaterThan(0);
    for (const slot of res.body.data.slots) {
      expect(slot.max_capacity).toBe(7);
    }
  });

  it("is deterministic for unchanged DB state", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    seedScheduled(istInstant(TODAY, "18:30"), "CONFIRMED");
    seedScheduled(istInstant(TODAY, "18:45"), "PREPARING");

    const first = await fetchSlots(TODAY).expect(200);
    const second = await fetchSlots(TODAY).expect(200);
    expect(first.body.data.slots).toEqual(second.body.data.slots);
  });

  it("counts only persisted qualifying orders (no randomness)", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    seedScheduled(istInstant(TODAY, "18:30"), "CONFIRMED");
    seedScheduled(istInstant(TODAY, "18:30"), "ALMOST_READY");
    seedScheduled(istInstant(TODAY, "19:00"), "READY_FOR_PICKUP");

    const { body } = await fetchSlots(TODAY).expect(200);
    const slots = body.data.slots as PickupSlotDTO[];
    expect(findSlot(slots, "18:30").current_orders).toBe(2);
    expect(findSlot(slots, "19:00").current_orders).toBe(1);
    expect(findSlot(slots, "18:00").current_orders).toBe(0);
    expect(findSlot(slots, "19:15").current_orders).toBe(0);
  });

  it("returns all slots available when there are zero orders", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const { body } = await fetchSlots(TOMORROW).expect(200);
    expect(body.data.slots).toHaveLength(15 * 4);
    expect(
      body.data.slots.every(
        (s: PickupSlotDTO) => s.available && s.current_orders === 0,
      ),
    ).toBe(true);
  });

  it("honours the capacity-1 boundary", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    setCapacity(1);
    seedScheduled(istInstant(TOMORROW, "10:00"), "CONFIRMED");

    const { body } = await fetchSlots(TOMORROW).expect(200);
    const slots = body.data.slots as PickupSlotDTO[];
    expect(findSlot(slots, "10:00").current_orders).toBe(1);
    expect(findSlot(slots, "10:00").available).toBe(false);
    expect(findSlot(slots, "10:15").current_orders).toBe(0);
    expect(findSlot(slots, "10:15").available).toBe(true);
  });

  it("marks a slot unavailable when capacity is exactly reached", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      seedScheduled(istInstant(TOMORROW, "11:00"), "CONFIRMED");
    }
    const { body } = await fetchSlots(TOMORROW).expect(200);
    const slot = findSlot(body.data.slots, "11:00");
    expect(slot.current_orders).toBe(3);
    expect(slot.available).toBe(false);
  });

  it("marks a slot unavailable when capacity is exceeded", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      seedScheduled(istInstant(TOMORROW, "11:00"), "PREPARING");
    }
    const { body } = await fetchSlots(TOMORROW).expect(200);
    const slot = findSlot(body.data.slots, "11:00");
    expect(slot.current_orders).toBe(4);
    expect(slot.available).toBe(false);
  });

  it("excludes non-active order statuses from occupancy", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    setCapacity(20);
    const included: OrderStatus[] = [
      "CONFIRMED",
      "PREPARING",
      "ALMOST_READY",
      "READY_FOR_PICKUP",
    ];
    const excluded: OrderStatus[] = [
      "DRAFT",
      "PAYMENT_PENDING",
      "PICKED_UP",
      "SETTLED",
      "CANCELLED",
      "REFUNDED",
      "PAYMENT_FAILED",
      "EXPIRED",
      "DISPUTED",
    ];
    for (const status of included) seedScheduled(istInstant(TOMORROW, "12:00"), status);
    for (const status of excluded) seedScheduled(istInstant(TOMORROW, "12:00"), status);

    const { body } = await fetchSlots(TOMORROW).expect(200);
    expect(findSlot(body.data.slots, "12:00").current_orders).toBe(included.length);
  });

  it("isolates occupancy per 15-minute slot", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    seedScheduled(istInstant(TOMORROW, "10:30"), "CONFIRMED");
    seedScheduled(istInstant(TOMORROW, "11:30"), "CONFIRMED");

    const { body } = await fetchSlots(TOMORROW).expect(200);
    const slots = body.data.slots as PickupSlotDTO[];
    expect(findSlot(slots, "10:30").current_orders).toBe(1);
    expect(findSlot(slots, "10:45").current_orders).toBe(0);
    expect(findSlot(slots, "11:15").current_orders).toBe(0);
    expect(findSlot(slots, "11:30").current_orders).toBe(1);
  });

  it("buckets by inclusive start (10:15 owns 10:15..10:29)", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    seedScheduled(istInstant(TOMORROW, "10:14"), "CONFIRMED");
    seedScheduled(istInstant(TOMORROW, "10:15"), "CONFIRMED");
    seedScheduled(istInstant(TOMORROW, "10:29"), "CONFIRMED");

    const { body } = await fetchSlots(TOMORROW).expect(200);
    const slots = body.data.slots as PickupSlotDTO[];
    expect(findSlot(slots, "10:00").current_orders).toBe(1);
    expect(findSlot(slots, "10:15").current_orders).toBe(2);
    expect(findSlot(slots, "10:30").current_orders).toBe(0);
  });

  it("excludes orders with no scheduled pickup time (ASAP)", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    seedScheduled(null, "CONFIRMED");

    const { body } = await fetchSlots(TOMORROW).expect(200);
    expect(
      body.data.slots.every((s: PickupSlotDTO) => s.current_orders === 0),
    ).toBe(true);
  });

  it("starts same-day at the next hour, never earlier than 08:00", async () => {
    setUtcClock("2026-08-24T14:00:00.000Z"); // 19:30 IST
    const res = await fetchSlots(TODAY).expect(200);
    expect(res.body.data.slots.length).toBeGreaterThan(0);
    const firstHour = Number(res.body.data.slots[0].time.slice(0, 2));
    expect(firstHour).toBeGreaterThanOrEqual(20);
  });

  it("returns an empty list when the same-day window has closed", async () => {
    setUtcClock("2026-08-24T17:00:00.000Z"); // 22:30 IST
    const res = await fetchSlots(TODAY).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.slots).toEqual([]);
  });

  it("returns an empty list for a past IST date", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z"); // 17:30 IST on 08-24
    const res = await fetchSlots("2026-08-23").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.slots).toEqual([]);
  });

  it("returns the full 08:00-22:45 window for a future IST date", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const res = await fetchSlots(TOMORROW).expect(200);
    expect(res.body.data.slots).toHaveLength(15 * 4);
    expect(res.body.data.slots[0].time).toBe("08:00");
    expect(res.body.data.slots[res.body.data.slots.length - 1].time).toBe("22:45");
  });

  it("derives the calendar day in IST across the UTC day rollover", async () => {
    // 2026-08-24T19:00:00Z = 2026-08-25 00:30 IST.
    setUtcClock("2026-08-24T19:00:00.000Z");
    // The UTC date is still 08-24, but IST "today" is 08-25. Requesting the
    // UTC date must be treated as a past IST date...
    const past = await fetchSlots(TODAY).expect(200);
    expect(past.body.data.slots).toEqual([]);
    // ...while the IST date is same-day and returns a non-empty window.
    const istToday = await fetchSlots(TOMORROW).expect(200);
    expect(istToday.body.data.slots.length).toBeGreaterThan(0);
    expect(istToday.body.data.slots[0].time).toBe("08:00");
  });

  it("keeps slots chronological", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const res = await fetchSlots(TODAY).expect(200);
    const times = res.body.data.slots.map((s: PickupSlotDTO) => s.time);
    expect(times).toEqual([...times].sort());
  });

  it("returns 404 for an inactive restaurant", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const res = await fetchSlots(TODAY, INACTIVE_ID).expect(404);
    expect(res.body.error.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("returns 400 for an invalid date format", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    const res = await fetchSlots("not-a-date").expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("fails closed with 503 when capacity is not configured (non-production)", async () => {
    setUtcClock("2026-08-24T12:00:00.000Z");
    setCapacity(null);
    const res = await fetchSlots(TODAY).expect(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("PICKUP_SLOT_CAPACITY_UNCONFIGURED");
  });
});
