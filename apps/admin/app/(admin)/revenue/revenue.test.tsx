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
    commission_rate: 0.08,
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

  it("renders totals, payment split, top vendors, and settlement", async () => {
    render(<RevenuePage />);
    expect(await screen.findByText("₹2,000")).toBeTruthy();
    expect((await screen.findAllByText("Biryani House")).length).toBeGreaterThan(0);
    expect(screen.getByText("UPI")).toBeTruthy();
    expect(screen.getByText("COD")).toBeTruthy();
    expect(screen.getByText("Vendor Settlement")).toBeTruthy();
  });

  it("switches between 7 and 30 day windows", async () => {
    render(<RevenuePage />);
    await screen.findByText("₹2,000");

    fireEvent.click(screen.getByText("30 days"));
    expect(mocks.fetchRevenue).toHaveBeenLastCalledWith(30);
  });
});
