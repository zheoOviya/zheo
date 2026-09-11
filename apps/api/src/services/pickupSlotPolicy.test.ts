import { describe, expect, it } from "vitest";
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  isValidPickupSlotInstant,
  slotWindowStartHour,
} from "./pickupSlotPolicy";

// ============================================
// Pickup-slot write policy (PICKUP-SLOT-WRITE-VALIDATION-A2)
//
// Pins the write-time membership rules to the released display calendar:
// fixed IST, 15-minute grid, [08:00, 23:00), same-day next-full-hour start.
// ============================================

/** IST wall-clock instant as a UTC ISO string. */
function istIso(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00+05:30`).toISOString();
}

// 2026-08-24T12:00:00Z = 17:30 IST, so same-day starts at 18:00.
const NOW = new Date("2026-08-24T12:00:00.000Z");
const FUTURE = "2026-08-25";
const TODAY = "2026-08-24";
const PAST = "2026-08-23";

describe("isValidPickupSlotInstant", () => {
  it("accepts the 08:00 window start on a future date", () => {
    expect(isValidPickupSlotInstant(istIso(FUTURE, "08:00"), NOW)).toEqual({
      valid: true,
    });
  });

  it("accepts the 22:45 last slot and rejects 23:00", () => {
    expect(isValidPickupSlotInstant(istIso(FUTURE, "22:45"), NOW).valid).toBe(true);
    expect(isValidPickupSlotInstant(istIso(FUTURE, "23:00"), NOW)).toEqual({
      valid: false,
      reason: "outside_window",
    });
  });

  it("rejects slots before the 08:00 window start", () => {
    expect(isValidPickupSlotInstant(istIso(FUTURE, "07:45"), NOW)).toEqual({
      valid: false,
      reason: "outside_window",
    });
    expect(isValidPickupSlotInstant(istIso(FUTURE, "07:59"), NOW).valid).toBe(false);
  });

  it("rejects an off-grid minute", () => {
    expect(isValidPickupSlotInstant(istIso(FUTURE, "12:07"), NOW)).toEqual({
      valid: false,
      reason: "off_grid",
    });
  });

  it("rejects non-zero seconds and milliseconds", () => {
    expect(
      isValidPickupSlotInstant(`${FUTURE}T12:00:30+05:30`, NOW).valid,
    ).toBe(false);
    expect(
      isValidPickupSlotInstant(`${FUTURE}T12:00:00.500+05:30`, NOW).valid,
    ).toBe(false);
  });

  it("rejects a past IST date", () => {
    expect(isValidPickupSlotInstant(istIso(PAST, "12:00"), NOW)).toEqual({
      valid: false,
      reason: "past_date",
    });
  });

  it("rejects a same-day slot before the next full hour", () => {
    expect(isValidPickupSlotInstant(istIso(TODAY, "17:45"), NOW)).toEqual({
      valid: false,
      reason: "same_day_not_offered",
    });
    expect(isValidPickupSlotInstant(istIso(TODAY, "18:00"), NOW).valid).toBe(true);
  });

  it("rejects every same-day slot once the window has closed", () => {
    const late = new Date("2026-08-24T17:00:00.000Z"); // 22:30 IST
    expect(isValidPickupSlotInstant(istIso(TODAY, "22:30"), late)).toEqual({
      valid: false,
      reason: "same_day_not_offered",
    });
  });

  it("derives the IST day across the UTC day rollover", () => {
    const afterRollover = new Date("2026-08-24T19:00:00.000Z"); // 00:30 IST 08-25
    expect(isValidPickupSlotInstant(istIso("2026-08-25", "08:00"), afterRollover).valid).toBe(true);
    expect(isValidPickupSlotInstant(istIso("2026-08-24", "22:00"), afterRollover)).toEqual({
      valid: false,
      reason: "past_date",
    });
  });

  it("normalizes a non-IST offset to the absolute instant", () => {
    // 04:30Z = 10:00 IST -> valid.
    expect(isValidPickupSlotInstant("2026-08-25T04:30:00.000Z", NOW).valid).toBe(true);
    // 02:30Z = 08:00 IST -> valid (exact window start).
    expect(isValidPickupSlotInstant("2026-08-25T02:30:00.000Z", NOW).valid).toBe(true);
    // 04:37Z = 10:07 IST -> off-grid even though 04:37 is not a UTC slot.
    expect(isValidPickupSlotInstant("2026-08-25T04:37:00.000Z", NOW)).toEqual({
      valid: false,
      reason: "off_grid",
    });
    // 17:30Z = 23:00 IST -> outside the window.
    expect(isValidPickupSlotInstant("2026-08-25T17:30:00.000Z", NOW)).toEqual({
      valid: false,
      reason: "outside_window",
    });
  });

  it("rejects an unparseable datetime", () => {
    expect(isValidPickupSlotInstant("not-a-date", NOW)).toEqual({
      valid: false,
      reason: "invalid_datetime",
    });
  });
});

describe("slotWindowStartHour", () => {
  it("uses the next full IST hour for same-day, floored at 08:00", () => {
    expect(slotWindowStartHour(TODAY, NOW)).toBe(18);
    expect(slotWindowStartHour(TODAY, new Date("2026-08-24T01:00:00.000Z"))).toBe(
      DAY_START_HOUR,
    );
    expect(slotWindowStartHour(FUTURE, NOW)).toBe(DAY_START_HOUR);
  });

  it("collapses to the exclusive day end once the same-day window closes", () => {
    const late = new Date("2026-08-24T17:00:00.000Z"); // 22:30 IST
    expect(slotWindowStartHour(TODAY, late)).toBe(DAY_END_HOUR);
  });
});
