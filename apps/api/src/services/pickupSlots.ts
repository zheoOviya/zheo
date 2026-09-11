import type { OrderStatus } from "@snakzap/types";
import { config } from "../config";
import { AppError } from "../middleware/envelope";
import type { OrderRepository } from "../repositories/orderRepository";
import {
  DAY_END_HOUR,
  IST_OFFSET_MS,
  MS_PER_DAY,
  MS_PER_MINUTE,
  SLOTS_PER_HOUR,
  SLOT_DURATION_MINUTES,
  istDateString,
  istMidnightUtc,
  slotWindowStartHour,
} from "./pickupSlotPolicy";

// Re-exported so existing importers of this module keep the same surface.
export { IST_OFFSET_MS, istDateString };

// ============================================
// Pickup-slot truth (PICKUP-SLOT-TRUTH-A2)
//
// Availability is DISPLAYED occupancy computed from persisted orders plus a
// configured per-slot capacity. The authoritative timezone is a fixed IST
// offset (UTC+05:30; India has no DST) so results never depend on the host
// process timezone. The `date` input is an IST calendar date; slot
// boundaries are converted to UTC instants before being compared with the
// persisted timestamptz `orders.scheduled_pickup_time`.
//
// This module computes displayed availability only. It deliberately does not
// reserve or lock a slot, so concurrent bookings can still oversubscribe.
// Enforcing capacity is owned by the separate
// PICKUP-SLOT-CAPACITY-ENFORCEMENT stream.
// ============================================

/**
 * Order statuses that represent a live commitment to a pickup slot. Must stay
 * aligned with the active fulfilment chain (see services/fulfillment.ts):
 * DRAFT/PAYMENT_PENDING are not yet committed and the terminal states
 * (PICKED_UP/SETTLED/CANCELLED/...) no longer occupy a slot.
 */
export const PICKUP_SLOT_OCCUPANCY_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
]);

// Production must never serve pickup availability it cannot compute
// truthfully. Mirrors the existing production guards for Razorpay/Petpooja.
if (config.env === "production" && config.pickupSlots.capacity === null) {
  throw new Error("PICKUP_SLOT_CAPACITY is required in production");
}

export interface PickupSlotDTO {
  time: string;
  label: string;
  available: boolean;
  current_orders: number;
  max_capacity: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Truthful pickup-slot window for an IST calendar date.
 *
 * - Past IST date -> empty list (the success envelope is unchanged).
 * - Same-day -> only future slots; the window starts no earlier than 08:00.
 * - Future date -> the full 08:00-22:45 window.
 */
export async function generatePickupSlots(
  orderRepo: OrderRepository,
  restaurantId: string,
  forDate: string,
  now: Date = new Date(),
): Promise<PickupSlotDTO[]> {
  const capacity = config.pickupSlots.capacity;
  if (capacity === null) {
    throw new AppError(
      "PICKUP_SLOT_CAPACITY_UNCONFIGURED",
      "Pickup slot availability is not configured",
      503,
    );
  }

  const today = istDateString(now);
  if (forDate < today) return [];

  const startHour = slotWindowStartHour(forDate, now);
  if (startHour >= DAY_END_HOUR) return [];

  const dayStart = istMidnightUtc(forDate);
  const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

  const orders = await orderRepo.getOrdersScheduledBetween(
    restaurantId,
    dayStart.toISOString(),
    dayEnd.toISOString(),
  );

  // Bucket qualifying orders once so per-slot counting is an O(1) lookup.
  const slotMs = SLOT_DURATION_MINUTES * MS_PER_MINUTE;
  const occupancy = new Map<number, number>();
  for (const order of orders) {
    if (!PICKUP_SLOT_OCCUPANCY_STATUSES.has(order.status)) continue;
    if (order.scheduled_pickup_time === null) continue;
    const t = new Date(order.scheduled_pickup_time).getTime();
    if (!Number.isFinite(t)) continue;
    const offsetMs = t - dayStart.getTime();
    if (offsetMs < 0 || offsetMs >= MS_PER_DAY) continue;
    const bucket = Math.floor(offsetMs / slotMs) * slotMs;
    occupancy.set(bucket, (occupancy.get(bucket) ?? 0) + 1);
  }

  const slots: PickupSlotDTO[] = [];
  for (let hour = startHour; hour < DAY_END_HOUR; hour++) {
    for (let i = 0; i < SLOTS_PER_HOUR; i++) {
      const minute = i * SLOT_DURATION_MINUTES;
      const offsetMs = (hour * 60 + minute) * MS_PER_MINUTE;
      const currentOrders = occupancy.get(offsetMs) ?? 0;
      const time = `${pad(hour)}:${pad(minute)}`;
      slots.push({
        time,
        label: time,
        available: currentOrders < capacity,
        current_orders: currentOrders,
        max_capacity: capacity,
      });
    }
  }
  return slots;
}
