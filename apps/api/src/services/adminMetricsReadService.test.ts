import { beforeEach, describe, expect, it } from "vitest";
import {
  computeAdminMetrics,
  istDateKeys,
  istDayKey,
  istTodayStart,
} from "./adminMetricsReadService";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";

// ============================================
// Admin platform truth metrics unit tests
// (ADMIN-PLATFORM-TRUTH)
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const USER_ID = "metric-service-user-000000000001";

function makeOrder(
  id: string,
  createdAtIso: string,
  status: OrderDTO["status"],
  totalAmount: number,
): OrderDTO {
  return {
    id,
    user_id: USER_ID,
    restaurant_id: REST_ID,
    restaurant_name: "Test Cafe",
    items: [],
    total_amount: totalAmount,
    status,
    commission_rate: 0.08,
    commission_amount: Math.round(totalAmount * 0.08),
    is_catering: false,
    headcount: null,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAtIso,
    updated_at: createdAtIso,
  };
}

describe("istDayKey", () => {
  it("maps 18:30 UTC (00:00 IST next day) to the next IST day", () => {
    expect(istDayKey("2026-08-14T18:30:00.000Z")).toBe("2026-08-15");
  });

  it("maps 18:29:59 UTC (23:59 IST same day) to the same IST day", () => {
    expect(istDayKey("2026-08-14T18:29:59.999Z")).toBe("2026-08-14");
  });
});

describe("istTodayStart", () => {
  it("returns the absolute UTC instant of the IST midnight boundary", () => {
    const now = new Date("2026-08-15T05:00:00.000Z");
    expect(istTodayStart(now).toISOString()).toBe("2026-08-14T18:30:00.000Z");
  });
});

describe("istDateKeys", () => {
  it("returns 7 ascending keys ending with the current IST day", () => {
    const now = new Date("2026-08-15T00:05:00.000Z");
    const keys = istDateKeys(7, now);
    expect(keys).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
  });
});

describe("computeAdminMetrics", () => {
  let repo: MemoryOrderRepository;
  const NOW = new Date("2026-08-15T00:00:00.000Z");

  beforeEach(() => {
    repo = new MemoryOrderRepository();
  });

  it("returns all-zero truthful metrics for an empty repository", async () => {
    const metrics = await computeAdminMetrics(repo, NOW);
    expect(metrics.revenue_today).toBe(0);
    expect(metrics.fulfilled_orders_today).toBe(0);
    expect(metrics.active_orders).toBe(0);
    expect(metrics.daily_series.length).toBe(7);
    expect(metrics.daily_series[6]!.date).toBe("2026-08-15");
    expect(metrics.daily_series.map((p) => p.revenue)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(metrics.daily_series.map((p) => p.fulfilled_orders)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("counts PICKED_UP and SETTLED as today revenue; excludes cancelled/refunded/non-placed", async () => {
    const today = NOW.toISOString();
    repo._seed(makeOrder("o-picked", today, "PICKED_UP", 1000));
    repo._seed(makeOrder("o-settled", today, "SETTLED", 500));
    repo._seed(makeOrder("o-confirmed", today, "CONFIRMED", 120));
    repo._seed(makeOrder("o-cancelled", today, "CANCELLED", 9000));
    repo._seed(makeOrder("o-refunded", today, "REFUNDED", 8000));
    repo._seed(makeOrder("o-draft", today, "DRAFT", 999));
    repo._seed(makeOrder("o-pending", today, "PAYMENT_PENDING", 998));

    const metrics = await computeAdminMetrics(repo, NOW);
    expect(metrics.revenue_today).toBe(1500);
    expect(metrics.fulfilled_orders_today).toBe(2);
    expect(metrics.active_orders).toBe(1);
    expect(metrics.daily_series[6]!.revenue).toBe(1500);
    expect(metrics.daily_series[6]!.fulfilled_orders).toBe(2);
  });

  it("excludes prior-day revenue from today while keeping it in yesterday's bucket", async () => {
    const yesterday = new Date(NOW.getTime() - 86400000).toISOString();
    repo._seed(makeOrder("o-yesterday", yesterday, "PICKED_UP", 777));

    const metrics = await computeAdminMetrics(repo, NOW);
    expect(metrics.revenue_today).toBe(0);
    expect(metrics.fulfilled_orders_today).toBe(0);
    expect(metrics.daily_series[5]!.revenue).toBe(777);
    expect(metrics.daily_series[6]!.revenue).toBe(0);
  });

  it("never leaks pre-window orders into the 7-day series", async () => {
    const preWindow = new Date(NOW.getTime() - 8 * 86400000).toISOString();
    repo._seed(makeOrder("o-prewindow", preWindow, "SETTLED", 12345));

    const metrics = await computeAdminMetrics(repo, NOW);
    expect(metrics.daily_series.map((p) => p.revenue)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(metrics.revenue_today).toBe(0);
  });

  it("fills multiple buckets across the 7-day window without fabricating values", async () => {
    const day = (offsetDays: number) =>
      new Date(NOW.getTime() - offsetDays * 86400000).toISOString();
    repo._seed(makeOrder("o-1", day(0), "PICKED_UP", 100));
    repo._seed(makeOrder("o-2", day(1), "PICKED_UP", 200));
    repo._seed(makeOrder("o-3", day(5), "SETTLED", 400));
    repo._seed(makeOrder("o-4", day(6), "PICKED_UP", 50));

    const metrics = await computeAdminMetrics(repo, NOW);
    expect(metrics.revenue_today).toBe(100);
    expect(metrics.fulfilled_orders_today).toBe(1);
    expect(metrics.daily_series).toEqual([
      { date: "2026-08-09", revenue: 50, fulfilled_orders: 1 },
      { date: "2026-08-10", revenue: 400, fulfilled_orders: 1 },
      { date: "2026-08-11", revenue: 0, fulfilled_orders: 0 },
      { date: "2026-08-12", revenue: 0, fulfilled_orders: 0 },
      { date: "2026-08-13", revenue: 0, fulfilled_orders: 0 },
      { date: "2026-08-14", revenue: 200, fulfilled_orders: 1 },
      { date: "2026-08-15", revenue: 100, fulfilled_orders: 1 },
    ]);
  });
});
