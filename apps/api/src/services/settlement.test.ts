import { describe, expect, it } from "vitest";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";
import { sharedOrderRepo } from "../repositories/shared";
import {
  buildSettlementSummary,
  computeCommission,
  computePackagingFee,
  computeSettlementLine,
  computeTaxes,
  generateDailySettlement,
  previousSettlementWindow,
} from "./settlement";

// ============================================
// V11 Settlement Engine - pure calculation tests
// ============================================

function item(overrides: Partial<OrderItemDTO>): OrderItemDTO {
  return {
    id: `itm-${Math.random()}`,
    menu_item_id: "b0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    base_price: 220,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: 220,
    ...overrides,
  };
}

function order(
  id: string,
  totalAmount: number,
  items: OrderItemDTO[],
  createdAt: string,
): OrderDTO {
  return {
    id,
    user_id: "u00000000-0000-4000-8000-000000000001",
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    items,
    total_amount: totalAmount,
    status: "PICKED_UP",
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

describe("computeCommission", () => {
  it("applies 0% commission at or below the Rs 200 threshold", () => {
    expect(computeCommission(200)).toEqual({ rate: 0, amount: 0 });
    expect(computeCommission(150)).toEqual({ rate: 0, amount: 0 });
  });

  it("applies 8% commission above the Rs 200 threshold", () => {
    expect(computeCommission(500)).toEqual({ rate: 0.08, amount: 40 });
    expect(computeCommission(201)).toEqual({ rate: 0.08, amount: 16.08 });
  });
});

describe("computeTaxes", () => {
  it("recomputes GST 5% on food and 18% on packaging from items", () => {
    const single = item({ item_subtotal: 150, quantity: 1 });
    expect(computeTaxes([single])).toEqual({
      gst_food: 7.5,
      gst_packaging: 1.8,
      taxes: 9.3,
    });
  });

  it("charges Rs 10 packaging per item", () => {
    const two = [
      item({ item_subtotal: 100, quantity: 1 }),
      item({ item_subtotal: 100, quantity: 2 }),
    ];
    expect(computePackagingFee(two)).toBe(30);
  });
});

describe("computeSettlementLine", () => {
  it("low-value order: 0% commission, payout = total - taxes", () => {
    const low = order(
      "o1",
      169.3,
      [item({ item_subtotal: 150 })],
      "2026-08-04T10:00:00.000Z",
    );
    const line = computeSettlementLine(low);
    expect(line.total_amount).toBe(169.3);
    expect(line.food_subtotal).toBe(150);
    expect(line.packaging_fee).toBe(10);
    expect(line.gst_food).toBe(7.5);
    expect(line.gst_packaging).toBe(1.8);
    expect(line.commission_rate).toBe(0);
    expect(line.commission_amount).toBe(0);
    expect(line.taxes).toBe(9.3);
    expect(line.payout).toBe(160);
  });

  it("high-value order: 8% commission on total_amount", () => {
    const high = order(
      "o2",
      500,
      [item({ item_subtotal: 450, quantity: 1 })],
      "2026-08-04T12:00:00.000Z",
    );
    const line = computeSettlementLine(high);
    expect(line.commission_rate).toBe(0.08);
    expect(line.commission_amount).toBe(40);
    expect(line.gst_food).toBe(22.5);
    expect(line.gst_packaging).toBe(1.8);
    expect(line.taxes).toBe(24.3);
    expect(line.payout).toBe(435.7);
  });
});

describe("buildSettlementSummary", () => {
  it("aggregates totals across orders", () => {
    const orders = [
      order(
        "o1",
        169.3,
        [item({ item_subtotal: 150 })],
        "2026-08-04T10:00:00.000Z",
      ),
      order(
        "o2",
        500,
        [item({ item_subtotal: 450, quantity: 1 })],
        "2026-08-04T12:00:00.000Z",
      ),
    ];
    const summary = buildSettlementSummary(orders, "2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
    expect(summary.order_count).toBe(2);
    expect(summary.total_food_subtotal).toBe(600);
    expect(summary.total_commission).toBe(40);
    expect(summary.total_taxes).toBe(33.6);
    expect(summary.net_payout).toBe(595.7);
    expect(summary.lines).toHaveLength(2);
  });

  it("returns an empty summary when there are no orders", () => {
    const summary = buildSettlementSummary([], "2026-08-04T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
    expect(summary.order_count).toBe(0);
    expect(summary.net_payout).toBe(0);
    expect(summary.lines).toHaveLength(0);
  });
});

describe("previousSettlementWindow", () => {
  it("returns the UTC day boundaries for yesterday", () => {
    const now = new Date("2026-08-05T15:30:00.000Z");
    const { periodStart, periodEnd } = previousSettlementWindow(now);
    expect(periodStart).toBe("2026-08-04T00:00:00.000Z");
    expect(periodEnd).toBe("2026-08-05T00:00:00.000Z");
  });
});

describe("generateDailySettlement", () => {
  it("fetches previous-day orders, computes the summary and renders a PDF", async () => {
    sharedOrderRepo._reset();
    sharedOrderRepo._seed(
      order(
        "o1",
        169.3,
        [item({ item_subtotal: 150 })],
        "2026-08-04T10:00:00.000Z",
      ),
    );
    sharedOrderRepo._seed(
      order(
        "o2",
        500,
        [item({ item_subtotal: 450, quantity: 1 })],
        "2026-08-04T12:00:00.000Z",
      ),
    );

    const result = await generateDailySettlement(
      sharedOrderRepo,
      "a0000000-0000-4000-8000-000000000001",
      "Biryani House",
      new Date("2026-08-05T09:00:00.000Z"),
    );

    expect(result.summary.order_count).toBe(2);
    expect(result.summary.total_commission).toBe(40);
    expect(result.summary.net_payout).toBe(595.7);
    expect(result.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.pdf.length).toBeGreaterThan(1000);
  });
});
