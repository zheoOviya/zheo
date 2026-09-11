import { AppError } from "../middleware/envelope";

// ============================================
// Pickup-slot time policy (PICKUP-SLOT-WRITE-VALIDATION-A2)
//
// Single source of truth for the IST pickup-slot calendar: fixed offset
// (UTC+05:30, no DST), the 15-minute grid, the [08:00, 23:00) window and the
// same-day "next full hour" cutoff. The released display service
// (services/pickupSlots.ts) consumes these helpers so write-time validation
// can never drift from what the booking UI is allowed to offer.
//
// This module validates time membership only. It deliberately has no notion of
// capacity, reservation or locking; enforcing capacity is owned by the
// separate PICKUP-SLOT-CAPACITY-ENFORCEMENT stream.
// ============================================

/** Fixed IST offset from UTC: UTC+05:30. */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export const SLOT_DURATION_MINUTES = 15;
export const SLOTS_PER_HOUR = 60 / SLOT_DURATION_MINUTES;
export const DAY_START_HOUR = 8;
// Slots iterate [08:00, 23:00) so the last valid slot is 22:45.
export const DAY_END_HOUR = 23;
export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
export const MS_PER_SLOT = SLOT_DURATION_MINUTES * MS_PER_MINUTE;

/** IST calendar date (YYYY-MM-DD) for an instant. */
export function istDateString(instant: Date = new Date()): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of IST midnight for an IST calendar date. */
export function istMidnightUtc(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/**
 * First hour the display offers for an IST calendar date. Same-day starts at
 * the next full hour, never earlier than 08:00; future dates start at 08:00.
 */
export function slotWindowStartHour(forDate: string, now: Date): number {
  const firstHour =
    forDate === istDateString(now)
      ? new Date(now.getTime() + IST_OFFSET_MS).getUTCHours() + 1
      : DAY_START_HOUR;
  return Math.max(firstHour, DAY_START_HOUR);
}

export type PickupSlotInvalidReason =
  | "invalid_datetime"
  | "past_date"
  | "off_grid"
  | "outside_window"
  | "same_day_not_offered";

export interface PickupSlotValidity {
  valid: boolean;
  reason?: PickupSlotInvalidReason;
}

/**
 * True when `value` is an instant the booking UI would currently offer for its
 * IST date: exact 15-minute grid, inside [08:00, 23:00), not earlier than the
 * same-day window start, and not in the past. The supplied offset is
 * normalized to an absolute instant before the IST conversion, so a caller
 * cannot smuggle a slot through a different offset (e.g. +00:00).
 */
export function isValidPickupSlotInstant(
  value: string,
  now: Date = new Date(),
): PickupSlotValidity {
  const instantMs = Date.parse(value);
  if (!Number.isFinite(instantMs)) {
    return { valid: false, reason: "invalid_datetime" };
  }

  const forDate = istDateString(new Date(instantMs));
  if (forDate < istDateString(now)) {
    return { valid: false, reason: "past_date" };
  }

  const startHour = slotWindowStartHour(forDate, now);
  if (startHour >= DAY_END_HOUR) {
    return { valid: false, reason: "same_day_not_offered" };
  }

  const offsetMs = instantMs - istMidnightUtc(forDate).getTime();
  if (offsetMs < 0 || offsetMs >= MS_PER_DAY || offsetMs % MS_PER_SLOT !== 0) {
    return { valid: false, reason: "off_grid" };
  }

  const windowStartMs = DAY_START_HOUR * 60 * MS_PER_MINUTE;
  const windowEndMs = DAY_END_HOUR * 60 * MS_PER_MINUTE;
  if (offsetMs < windowStartMs || offsetMs >= windowEndMs) {
    return { valid: false, reason: "outside_window" };
  }

  if (offsetMs < startHour * 60 * MS_PER_MINUTE) {
    return { valid: false, reason: "same_day_not_offered" };
  }

  return { valid: true };
}

/**
 * Write-time guard for a consumer-chosen pickup slot. Throws the frozen
 * INVALID_PICKUP_SLOT / 400 domain error when the instant is not a slot the
 * display would offer.
 */
export function assertValidPickupSlot(
  value: string,
  now: Date = new Date(),
): void {
  if (!isValidPickupSlotInstant(value, now).valid) {
    throw new AppError(
      "INVALID_PICKUP_SLOT",
      "scheduled_pickup_time is not an available pickup slot",
      400,
    );
  }
}
