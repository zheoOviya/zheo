import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ELIGIBLE_INSIGHT_STATUSES,
  InsightsService,
  hourLabel,
  insightWindow,
  istDayStart,
  toIstHour,
} from "./insights";
import {
  MemoryOrderRepository,
  type OrderDTO,
  type OrderItemDTO,
} from "../repositories/orderRepository";

// ============================================
// Customer Insights Engine (V08) unit tests
//
// Frozen product truth (VENDOR-INSIGHTS-TRUTH-A2): the completed /
// revenue / AOV / peak-hours population is terminal-only
// {PICKED_UP, SETTLED}. In-flight orders are NOT completed.
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";

const IN_FLIGHT_STATUSES: OrderDTO["status"][] = [
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
];

const ABANDONED_OR_FAILED_STATUSES: OrderDTO["status"][] = [
  "DRAFT",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "DISPUTED",
];

function makeOrder(
  id: string,
  userId: string,
  createdAt: string,
  status: OrderDTO["status"],
  totalAmount: number,
  restaurantId = REST_ID,
): OrderDTO {
  const item: OrderItemDTO = {
    id: `itm-${id}`,
    menu_item_id: "b0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    base_price: 220,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: totalAmount,
    gift_id: null,
  };
  return {
    id,
    user_id: userId,
    restaurant_id: restaurantId,
    items: [item],
    total_amount: totalAmount,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function vendorSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("InsightsService", () => {
  let repo: MemoryOrderRepository;
  let service: InsightsService;

  beforeEach(() => {
    repo = new MemoryOrderRepository();
    service = new InsightsService(repo);
  });

  // T1/T2 contract: only terminal fulfilled states are eligible.
  it("counts only PICKED_UP and SETTLED as eligible", () => {
    expect([...ELIGIBLE_INSIGHT_STATUSES].sort()).toEqual(["PICKED_UP", "SETTLED"]);
    for (const status of [
      ...IN_FLIGHT_STATUSES,
      ...ABANDONED_OR_FAILED_STATUSES,
    ]) {
      expect(ELIGIBLE_INSIGHT_STATUSES.has(status)).toBe(false);
    }
  });

  it("converts timestamps to deterministic IST hours (+5:30 offset)", () => {
    expect(toIstHour("2026-08-04T10:00:00.000Z")).toBe(15); // 15:30 IST
    expect(toIstHour("2026-08-04T00:00:00.000Z")).toBe(5); // 05:30 IST
    expect(toIstHour("2026-08-04T18:45:00.000Z")).toBe(0); // 00:15 IST next day
  });

  it("formats 24-hour buckets as 12-hour labels", () => {
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(12)).toBe("12 PM");
    expect(hourLabel(15)).toBe("3 PM");
    expect(hourLabel(23)).toBe("11 PM");
  });

  // T8: gross total_amount is summed exactly over fulfilled orders.
  it("includes PICKED_UP and SETTLED and sums gross total_amount exactly", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    repo._seed(makeOrder("o1", "uA", hoursAgo(1), "PICKED_UP", 240));
    repo._seed(makeOrder("o2", "uA", hoursAgo(2), "SETTLED", 260));

    const insights = await service.compute(REST_ID, 30);

    expect(insights.order_count).toBe(2);
    expect(insights.total_revenue).toBe(500);
    expect(insights.aov).toBe(250);
  });

  // T3/T4/T5/T6/T7/T11: in-flight and abandoned/failed states are excluded.
  it("excludes every in-flight and abandoned/failed status from the metrics", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    // Genuine fulfilled sales.
    repo._seed(makeOrder("k1", "u1", hoursAgo(1), "PICKED_UP", 100));
    repo._seed(makeOrder("k2", "u2", hoursAgo(2), "SETTLED", 300));

    // In-flight pipeline: must never be treated as completed.
    IN_FLIGHT_STATUSES.forEach((status, i) => {
      repo._seed(makeOrder(`x${i}`, `p${i}`, hoursAgo(3 + i), status, 999));
    });

    // Abandoned or failed carts / refunds.
    ABANDONED_OR_FAILED_STATUSES.forEach((status, i) => {
      repo._seed(makeOrder(`y${i}`, `q${i}`, hoursAgo(7 + i), status, 999));
    });

    const insights = await service.compute(REST_ID, 30);

    expect(insights.order_count).toBe(2);
    expect(insights.total_revenue).toBe(400);
    expect(insights.aov).toBe(200);
    expect(insights.total_customers).toBe(2);
    expect(insights.repeat_rate).toBe(0);
    expect(insights.peak_hours.reduce((sum, b) => sum + b.order_count, 0)).toBe(2);
  });

  // T9: AOV numerator and denominator share the same fulfilled population.
  it("computes AOV over the same fulfilled population as the numerator", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    repo._seed(makeOrder("a1", "u1", hoursAgo(1), "SETTLED", 100));
    repo._seed(makeOrder("a2", "u2", hoursAgo(2), "PICKED_UP", 200));
    repo._seed(makeOrder("a3", "u3", hoursAgo(3), "SETTLED", 300));
    // In-flight orders must not inflate the denominator.
    repo._seed(makeOrder("b1", "u4", hoursAgo(4), "CONFIRMED", 999));
    repo._seed(makeOrder("b2", "u5", hoursAgo(5), "PREPARING", 999));

    const insights = await service.compute(REST_ID, 30);

    expect(insights.total_revenue).toBe(600);
    expect(insights.order_count).toBe(3);
    expect(insights.aov).toBe(200);
    expect(insights.total_revenue / insights.order_count).toBe(insights.aov);
  });

  // T10: no eligible orders -> literal zeroes.
  it("returns zeroed metrics when no fulfilled orders qualify", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    repo._seed(makeOrder("d1", "u1", hoursAgo(1), "CONFIRMED", 999));
    repo._seed(makeOrder("d2", "u2", hoursAgo(2), "DRAFT", 999));

    const insights = await service.compute(REST_ID, 30);

    expect(insights.order_count).toBe(0);
    expect(insights.total_revenue).toBe(0);
    expect(insights.aov).toBe(0);
    expect(insights.repeat_rate).toBe(0);
    expect(insights.peak_hours.every((b) => b.order_count === 0)).toBe(true);
  });

  it("computes repeat rate over fulfilled orders only", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    // User A: 2 fulfilled -> repeat customer.
    repo._seed(makeOrder("r1", "uA", hoursAgo(1), "PICKED_UP", 100));
    repo._seed(makeOrder("r2", "uA", hoursAgo(2), "SETTLED", 100));
    // User B: 1 fulfilled + 1 in-flight -> a customer, but not repeating.
    repo._seed(makeOrder("r3", "uB", hoursAgo(3), "SETTLED", 100));
    repo._seed(makeOrder("r4", "uB", hoursAgo(4), "CONFIRMED", 100));
    // User C: only in-flight -> not a customer at all.
    repo._seed(makeOrder("r5", "uC", hoursAgo(5), "READY_FOR_PICKUP", 100));

    const insights = await service.compute(REST_ID, 30);

    expect(insights.order_count).toBe(3);
    expect(insights.total_customers).toBe(2);
    expect(insights.repeat_customers).toBe(1);
    expect(insights.repeat_rate).toBe(0.5);
  });

  it("scopes peak hours to the order timestamps in IST buckets", async () => {
    // Fixtures anchored to YESTERDAY at 10:00:00.000Z (UTC) so all orders
    // stay inside the IST calendar window while the IST bucket is
    // deterministic: 10:00Z + 05:30 = 15:30 IST -> hour 15.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const baseDate = new Date(
      Date.UTC(
        yesterday.getUTCFullYear(),
        yesterday.getUTCMonth(),
        yesterday.getUTCDate(),
        10,
        0,
        0,
        0,
      ),
    );
    const base = baseDate.getTime();
    const expectedHour = toIstHour(baseDate.toISOString());
    expect(expectedHour).toBe(15);

    repo._seed(makeOrder("p1", "u1", new Date(base).toISOString(), "PICKED_UP", 100));
    repo._seed(makeOrder("p2", "u2", new Date(base + 60000).toISOString(), "SETTLED", 100));
    repo._seed(makeOrder("p3", "u3", new Date(base + 120000).toISOString(), "SETTLED", 100));
    // In-flight order at the same hour must not be counted.
    repo._seed(makeOrder("p4", "u4", new Date(base + 180000).toISOString(), "CONFIRMED", 100));

    const insights = await service.compute(REST_ID, 30);
    const bucket = insights.peak_hours.find((b) => b.hour === expectedHour);
    expect(bucket?.order_count).toBe(3);
  });

  // T12: IST calendar-day window boundaries (no rolling UTC / browser-local).
  it("derives the window from IST calendar days", () => {
    // 2026-09-15T20:00:00Z is 2026-09-16 01:30 IST.
    const now = new Date("2026-09-15T20:00:00.000Z");
    expect(istDayStart(now).toISOString()).toBe("2026-09-15T18:30:00.000Z");

    const { start, end } = insightWindow(7, now);
    expect(end.toISOString()).toBe("2026-09-15T20:00:00.000Z");
    // 7 IST days ending today (Sep 16 IST) -> starts Sep 10 IST = 18:30Z Sep 9.
    expect(start.toISOString()).toBe("2026-09-09T18:30:00.000Z");
    expect(start.getTime()).toBe(
      istDayStart(now).getTime() - 6 * 24 * 60 * 60 * 1000,
    );
  });

  // T13: the vendor UI must not claim paid-only / completed-only semantics.
  it("keeps vendor UI copy truthful about the fulfilled population", () => {
    const dashboard = vendorSource("../../../vendor/app/page.tsx");
    const insightsPage = vendorSource("../../../vendor/app/insights/page.tsx");
    const chainPage = vendorSource("../../../vendor/app/chain/page.tsx");

    for (const src of [dashboard, insightsPage, chainPage]) {
      expect(src).not.toMatch(/paid orders?/i);
      expect(src).not.toMatch(/completed only/i);
      expect(src).not.toMatch(/total of paid/i);
    }

    expect(dashboard).not.toContain("Today's Revenue");
    expect(dashboard).toContain("Today's Fulfilled Sales");
    expect(insightsPage).toContain("Fulfilled Sales");
    expect(chainPage).toContain("Lifetime Fulfilled Sales");
  });
});
