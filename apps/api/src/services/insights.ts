import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";
import { AppError } from "../middleware/envelope";

// ============================================
// Customer Insights Engine (PRD Phase 2, V08)
//
// Metrics are derived ONLY from orders whose status is a real
// fulfillment state. DRAFT / PAYMENT_PENDING / PAYMENT_FAILED /
// CANCELLED / EXPIRED / REFUNDED / DISPUTED are excluded, so
// abandoned carts never pollute the numbers.
//
//  - AOV          = total_revenue / order_count (2dp)
//  - Repeat rate  = distinct users with >=2 orders / distinct users >=1
//  - Peak hours   = 24 fixed buckets labeled in IST (Asia/Kolkata).
//                   Uses an explicit +5:30 offset instead of a locale
//                   formatter so results are deterministic in tests.
// ============================================

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export const ELIGIBLE_INSIGHT_STATUSES = new Set([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
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

export class InsightsService {
  constructor(private readonly orderRepo: OrderRepository) {}

  async compute(
    restaurantId: string,
    days: number,
  ): Promise<InsightsResult> {
    const windowEnd = new Date();
    const windowStart = new Date(
      windowEnd.getTime() - days * 24 * 60 * 60 * 1000,
    );
    const startIso = windowStart.toISOString();
    const endIso = windowEnd.toISOString();

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
