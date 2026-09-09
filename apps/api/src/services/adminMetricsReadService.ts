import type { OrderDTO, OrderRepository } from "../repositories/orderRepository";

// ============================================
// Admin platform truth metrics read service
// (ADMIN-PLATFORM-TRUTH)
//
// Dashboard / health / reports KPIs are derived ONLY from persisted order
// state. No operational constant is fabricated anywhere in this module.
//
//   revenue_today         = gross total_amount (incl. GST) summed over orders
//                           whose status is PICKED_UP or SETTLED and whose
//                           created_at falls on the IST placement day of
//                           "today". The order layer has no completion
//                           timestamp, so revenue is attributed to the order's
//                           IST placement day.
//   fulfilled_orders_today = count of the exact order set feeding revenue_today.
//   active_orders          = live pipeline count at request time.
//   daily_series           = last 7 IST day buckets ending with the partial
//                           current day. Zero-data buckets are literal 0.
//
// Refunded orders transition to REFUNDED (payments service) and therefore
// never appear in the PICKED_UP/SETTLED revenue set.
//
// Time contract: deterministic IST fixed offset (+05:30). India observes no
// DST, so a fixed-offset helper is timezone-invariant and test-safe.
// ============================================

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Orders whose gross total counts as realized revenue. Mirrors the
 *  settlement service's getSettlableOrdersByRestaurant convention. */
export const REVENUE_COMPLETED_STATUSES: ReadonlySet<OrderDTO["status"]> = new Set([
  "PICKED_UP",
  "SETTLED",
]);

/** Orders currently occupying the live kitchen/fulfillment pipeline. */
const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderDTO["status"]> = new Set([
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
]);

export interface AdminMetricsSeriesPoint {
  date: string;
  revenue: number;
  fulfilled_orders: number;
}

export interface AdminMetricsResult {
  revenue_today: number;
  fulfilled_orders_today: number;
  active_orders: number;
  daily_series: AdminMetricsSeriesPoint[];
}

/** Deterministic IST day key (YYYY-MM-DD) for a timestamp, via the fixed
 *  +05:30 offset. Equivalent semantics to InsightsService.toIstHour but at
 *  day granularity. */
export function istDayKey(isoTimestamp: string): string {
  const shifted = new Date(new Date(isoTimestamp).getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Last `days` IST day keys ascending, ending with the current (partial) day. */
export function istDateKeys(days: number, now: Date = new Date()): string[] {
  const shiftedNow = new Date(now.getTime() + IST_OFFSET_MS);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(
      Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate() - i),
    );
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

/** Start of the IST day containing `now`, as an absolute UTC instant. */
export function istTodayStart(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const dayStartShifted = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
  return new Date(dayStartShifted.getTime() - IST_OFFSET_MS);
}

/**
 * Compute the truthful Admin metrics for the current moment.
 *
 * `now` is injectable so boundary/bucket behaviour is deterministically
 * testable. The implementation scans the existing repository abstraction
 * (no raw DB access) and never synthesizes trend values.
 */
export async function computeAdminMetrics(
  orderRepo: Pick<OrderRepository, "getAll">,
  now: Date = new Date(),
): Promise<AdminMetricsResult> {
  const seriesKeys = istDateKeys(7, now);
  const todayKey = seriesKeys[seriesKeys.length - 1];
  const bucket = new Map<string, { date: string; revenue: number; fulfilled_orders: number }>();
  for (const key of seriesKeys) {
    bucket.set(key, { date: key, revenue: 0, fulfilled_orders: 0 });
  }

  const all = await orderRepo.getAll();
  let revenueToday = 0;
  let fulfilledToday = 0;
  let activeOrders = 0;

  for (const order of all) {
    if (ACTIVE_ORDER_STATUSES.has(order.status)) {
      activeOrders += 1;
    }
    if (!REVENUE_COMPLETED_STATUSES.has(order.status)) {
      continue;
    }
    const key = istDayKey(order.created_at);
    const point = bucket.get(key);
    if (!point) {
      // Prior-day / pre-window orders never leak into the 7-day series or the
      // "today" totals.
      continue;
    }
    const amount = Number(order.total_amount);
    point.revenue += amount;
    point.fulfilled_orders += 1;
    if (key === todayKey) {
      revenueToday += amount;
      fulfilledToday += 1;
    }
  }

  return {
    revenue_today: Math.round(revenueToday),
    fulfilled_orders_today: fulfilledToday,
    active_orders: activeOrders,
    daily_series: seriesKeys.map((key) => {
      const point = bucket.get(key)!;
      return {
        date: key,
        revenue: Math.round(point.revenue),
        fulfilled_orders: point.fulfilled_orders,
      };
    }),
  };
}
