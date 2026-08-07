import { beforeEach, describe, expect, it } from "vitest";
import {
  ELIGIBLE_INSIGHT_STATUSES,
  InsightsService,
  hourLabel,
  toIstHour,
} from "./insights";
import {
  MemoryOrderRepository,
  type OrderDTO,
  type OrderItemDTO,
} from "../repositories/orderRepository";

// ============================================
// Customer Insights Engine (V08) unit tests
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";

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

describe("InsightsService", () => {
  let repo: MemoryOrderRepository;
  let service: InsightsService;

  beforeEach(() => {
    repo = new MemoryOrderRepository();
    service = new InsightsService(repo);
  });

  it("ELIGIBLE_INSIGHT_STATUSES only contains fulfillment states", () => {
    for (const status of ELIGIBLE_INSIGHT_STATUSES) {
      expect(
        ["CONFIRMED", "PREPARING", "ALMOST_READY", "READY_FOR_PICKUP", "PICKED_UP", "SETTLED"],
      ).toContain(status);
    }
    expect(ELIGIBLE_INSIGHT_STATUSES.has("DRAFT")).toBe(false);
    expect(ELIGIBLE_INSIGHT_STATUSES.has("PAYMENT_PENDING")).toBe(false);
    expect(ELIGIBLE_INSIGHT_STATUSES.has("CANCELLED")).toBe(false);
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

  it("excludes non-fulfillment statuses and computes AOV + repeat rate", async () => {
    const now = Date.now();
    const hoursAgo = (n: number) => new Date(now - n * 3600_000).toISOString();

    // User A: 2 eligible orders -> repeat customer
    repo._seed(makeOrder("o1", "uA", hoursAgo(1), "CONFIRMED", 240));
    repo._seed(makeOrder("o2", "uA", hoursAgo(2), "PICKED_UP", 240));
    // User B: 1 eligible + 1 DRAFT (DRAFT excluded from metrics)
    repo._seed(makeOrder("o3", "uB", hoursAgo(3), "SETTLED", 260));
    repo._seed(makeOrder("o4", "uB", hoursAgo(4), "DRAFT", 999));
    // User C: cancelled only -> excluded entirely
    repo._seed(makeOrder("o5", "uC", hoursAgo(5), "CANCELLED", 999));
    // User D: outside the 30-day window -> excluded
    repo._seed(makeOrder("o6", "uD", hoursAgo(24 * 40), "PICKED_UP", 999));

    const insights = await service.compute(REST_ID, 30);

    expect(insights.order_count).toBe(3);
    expect(insights.total_revenue).toBe(740);
    expect(insights.aov).toBe(246.67);
    expect(insights.total_customers).toBe(2);
    expect(insights.repeat_customers).toBe(1);
    expect(insights.repeat_rate).toBe(0.5);
    expect(insights.peak_hours).toHaveLength(24);
    expect(insights.peak_hours.reduce((sum, b) => sum + b.order_count, 0)).toBe(
      3,
    );
  });

  it("returns zeroed metrics when no orders qualify", async () => {
    const insights = await service.compute(REST_ID, 30);
    expect(insights.order_count).toBe(0);
    expect(insights.total_revenue).toBe(0);
    expect(insights.aov).toBe(0);
    expect(insights.repeat_rate).toBe(0);
    expect(insights.peak_hours.every((b) => b.order_count === 0)).toBe(true);
  });

  it("scopes peak hours to the order timestamps in IST buckets", async () => {
    // All three orders at exactly the same clock time -> one bucket = 3
    const base = new Date("2026-08-04T10:00:00.000Z").getTime();
    repo._seed(makeOrder("p1", "u1", new Date(base).toISOString(), "CONFIRMED", 100));
    repo._seed(makeOrder("p2", "u2", new Date(base + 60000).toISOString(), "PICKED_UP", 100));
    repo._seed(makeOrder("p3", "u3", new Date(base + 120000).toISOString(), "SETTLED", 100));

    const insights = await service.compute(REST_ID, 30);
    const bucket = insights.peak_hours.find((b) => b.hour === 15);
    expect(bucket?.order_count).toBe(3);
  });
});
