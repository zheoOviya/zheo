// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RevenuePage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchRevenue: vi.fn(),
  fetchVendorMetrics: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);

const REPORT = {
  days: 7,
  series: [
    { date: "2026-08-08", revenue: 500, orders: 3, commission: 50 },
    { date: "2026-08-09", revenue: 900, orders: 5, commission: 90 },
    { date: "2026-08-10", revenue: 0, orders: 0, commission: 0 },
    { date: "2026-08-11", revenue: 0, orders: 0, commission: 0 },
    { date: "2026-08-12", revenue: 0, orders: 0, commission: 0 },
    { date: "2026-08-13", revenue: 0, orders: 0, commission: 0 },
    { date: "2026-08-14", revenue: 600, orders: 4, commission: 60 },
  ],
  totals: { revenue: 2000, orders: 12, commission: 200, average_order_value: 166 },
  payment_split: { upi: 7, cod: 5 },
  top_vendors: [{ restaurant_id: "a0000000-0000-4000-8000-000000000001", name: "Biryani House", revenue: 1500, orders: 9 }],
};

const VENDORS = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Biryani House",
    is_active: true,
    owner_id: "e1",
    order_count: 12,
    completed_orders: 9,
    revenue: 1500,
    commission: 150,
    active_orders: 2,
  },
];

describe("Admin revenue analytics page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchRevenue.mockResolvedValue(REPORT);
    mocks.fetchVendorMetrics.mockResolvedValue(VENDORS);
  });

  // T1/T3/T5/T6/T7/T8/T10/T11: selected-period gross metrics say "Fulfilled
  // Sales"; commission discloses its window; lifetime sections say lifetime;
  // vendor table uses fulfilled/commission column wording.
  it("labels selected-period gross sales truthfully and discloses lifetime sections", async () => {
    render(<RevenuePage />);

    // T1/T3: selected-period gross sales metric is "Fulfilled Sales (7d)".
    expect(await screen.findByText("Fulfilled Sales (7d)")).toBeTruthy();
    expect(screen.getByText("Fulfilled Orders (7d)")).toBeTruthy();
    // T5: platform commission discloses the same selected window.
    expect(screen.getByText("Platform Commission (7d)")).toBeTruthy();
    expect(screen.getByText("Avg Order Value")).toBeTruthy();
    // Series is gross fulfilled sales, not generic "revenue".
    expect(screen.getByText("Daily Fulfilled Sales")).toBeTruthy();

    // T6/T7/T8: lifetime sections disclose lifetime explicitly.
    expect(screen.getByText("Lifetime Payment Mix")).toBeTruthy();
    expect(screen.getByText("Lifetime Top Vendors")).toBeTruthy();
    expect(screen.getByText("Lifetime Vendor Performance")).toBeTruthy();

    // T9: "Vendor Settlement" is not settlement payout and must not appear.
    expect(screen.queryByText("Vendor Settlement")).toBeNull();
    expect(screen.queryByText(/settlement/i)).toBeNull();

    // T10/T11: vendor table columns use fulfilled/commission wording.
    expect(screen.getByText("Fulfilled Sales")).toBeTruthy();
    expect(screen.getByText("Fulfilled Orders")).toBeTruthy();
    expect(screen.getByText("Platform Commission")).toBeTruthy();

    // Values remain payload-derived (no numeric relabel).
    expect(screen.getByText("₹2,000")).toBeTruthy();
    expect(screen.getByText("₹200")).toBeTruthy();
    expect(screen.getByText("₹150")).toBeTruthy();
    expect(screen.getAllByText("Biryani House").length).toBeGreaterThan(0);
    expect(screen.getByText("UPI")).toBeTruthy();
    expect(screen.getByText("COD")).toBeTruthy();

    // T12: no unsupported "paid" wording introduced.
    expect(screen.queryByText(/paid/i)).toBeNull();
    // No copy implying the lifetime sections are window-scoped.
    expect(screen.queryByText(/in this window/i)).toBeNull();
  });

  // T4/T13: switching 7/30 changes only the period-scoped labels; lifetime
  // sections stay lifetime and the API call keeps its days contract.
  it("switches the selected period without implying lifetime sections change", async () => {
    render(<RevenuePage />);
    await screen.findByText("Fulfilled Sales (7d)");

    fireEvent.click(screen.getByText("30 days"));

    expect(await screen.findByText("Fulfilled Sales (30d)")).toBeTruthy();
    expect(screen.getByText("Fulfilled Orders (30d)")).toBeTruthy();
    expect(screen.getByText("Platform Commission (30d)")).toBeTruthy();

    // Lifetime sections are unaffected by the period selector.
    expect(screen.getByText("Lifetime Payment Mix")).toBeTruthy();
    expect(screen.getByText("Lifetime Top Vendors")).toBeTruthy();
    expect(screen.getByText("Lifetime Vendor Performance")).toBeTruthy();

    expect(mocks.fetchRevenue).toHaveBeenLastCalledWith(30);
  });
});
