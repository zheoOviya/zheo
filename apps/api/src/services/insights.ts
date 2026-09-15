import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import { AppError } from "../middleware/envelope";

// ============================================
// Customer Insights Engine (PRD Phase 2, V08)
//
// Metrics are derived ONLY from orders that reached a terminal
// fulfilled state: PICKED_UP or SETTLED. In-flight orders
// (CONFIRMED / PREPARING / ALMOST_READY / READY_FOR_PICKUP) and
// abandoned or failed carts (DRAFT / PAYMENT_PENDING /
// PAYMENT_FAILED / CANCELLED / EXPIRED / REFUNDED / DISPUTED) are
// excluded, so the numbers describe fulfilled sales only.
//
//  - order_count   = fulfilled orders inside the IST window
//  - total_revenue = gross fulfilled sales: SUM(total_amount) over the
//                    same fulfilled set. GST and packaging are already
//                    embedded in total_amount; commission is NOT
//                    deducted and no payment-state filter is applied.
//  - AOV           = total_revenue / order_count (2dp), same population
//  - Repeat rate   = distinct users with >=2 fulfilled orders /
//                    distinct users with >=1 fulfilled order
//  - Peak hours    = 24 fixed buckets labeled in IST (Asia/Kolkata).
//                    Uses an explicit +5:30 offset instead of a locale
//                    formatter so results are deterministic in tests.
//
// Window: last N IST calendar days, including the current (partial) day,
// using deterministic +05:30 boundaries (India observes no DST).
// ============================================

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Terminal fulfilled states. Mirrors the authoritative admin /
 * settlement policy (REVENUE_COMPLETED_STATUSES): an order counts only
 * once the customer has picked it up (PICKED_UP) or it has settled.
 * In-flight and abandoned/failed states never pollute these metrics.
 */
export const ELIGIBLE_INSIGHT_STATUSES = new Set([
  "PICKED_UP",
  "SETTLED",
]);

export interface PeakHourBucket {
  hour: number;
  label: string;
  order_count: number;
}

export interface InsightsResult {
  days: number;
  window_start: string;
  window_end: string;
  order_count: number;
  total_revenue: number;
  aov: number;
  repeat_rate: number;
  repeat_customers: number;
  total_customers: number;
  peak_hours: PeakHourBucket[];
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Deterministic IST hour (0-23) for a timestamp, via explicit +5:30 offset. */
export function toIstHour(isoTimestamp: string): number {
  const shifted = new Date(
    new Date(isoTimestamp).getTime() + IST_OFFSET_MS,
  );
  return shifted.getUTCHours();
}

export function hourLabel(hour: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${period}`;
}

function emptyPeakHours(): PeakHourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    order_count: 0,
  }));
}

/** Start of the IST day containing `now`, as an absolute UTC instant. */
export function istDayStart(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const dayStartShifted = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
  return new Date(dayStartShifted.getTime() - IST_OFFSET_MS);
}

/**
 * Frozen IST period window: the last `days` IST calendar days ending with
 * the current (partial) day. `start` is IST midnight of day
 * `now - (days - 1)`; `end` is `now`. No rolling 24h and no browser-local
 * drift, so the same order set is produced regardless of the caller's TZ.
 */
export function insightWindow(
  days: number,
  now: Date = new Date(),
): { start: Date; end: Date } {
  return {
    start: new Date(istDayStart(now).getTime() - (days - 1) * DAY_MS),
    end: now,
  };
}

export class InsightsService {
  constructor(private readonly orderRepo: OrderRepository) {}

  async compute(
    restaurantId: string,
    days: number,
  ): Promise<InsightsResult> {
    const { start, end } = insightWindow(days);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const allOrders = await this.orderRepo.getByRestaurant(restaurantId);
    const eligible = allOrders.filter(
      (o) =>
        ELIGIBLE_INSIGHT_STATUSES.has(o.status) &&
        o.created_at >= startIso &&
        o.created_at <= endIso,
    );

    const orderCount = eligible.length;
    const totalRevenue = round2(
      eligible.reduce((sum, o) => sum + o.total_amount, 0),
    );
    const aov = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;

    const userOrderCounts = new Map<string, number>();
    for (const order of eligible) {
      userOrderCounts.set(
        order.user_id,
        (userOrderCounts.get(order.user_id) ?? 0) + 1,
      );
    }
    const totalCustomers = userOrderCounts.size;
    const repeatCustomers = Array.from(userOrderCounts.values()).filter(
      (count) => count >= 2,
    ).length;
    const repeatRate =
      totalCustomers > 0 ? round2(repeatCustomers / totalCustomers) : 0;

    const peakHours = emptyPeakHours();
    for (const order of eligible) {
      const bucket = peakHours[toIstHour(order.created_at)];
      if (bucket) bucket.order_count += 1;
    }

    return {
      days,
      window_start: startIso,
      window_end: endIso,
      order_count: orderCount,
      total_revenue: totalRevenue,
      aov,
      repeat_rate: repeatRate,
      repeat_customers: repeatCustomers,
      total_customers: totalCustomers,
      peak_hours: peakHours,
    };
  }
}

export function parseInsightsDays(value: unknown): number {
  if (value === undefined) return 30;
  const parsed =
    typeof value === "string" && value.trim() !== ""
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 365) {
    throw new AppError(
      "VALIDATION_ERROR",
      "days must be an integer between 1 and 365",
      400,
    );
  }
  return parsed;
}
