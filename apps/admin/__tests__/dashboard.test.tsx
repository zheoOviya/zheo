// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardPage from "../app/(admin)/dashboard/page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchDashboardMetrics: vi.fn(),
  getTotpStatus: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  fetchDashboardMetrics: mocks.fetchDashboardMetrics,
}));

vi.mock("../lib/totp", () => ({
  getTotpStatus: mocks.getTotpStatus,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const METRICS = {
  revenue_today: 1500,
  fulfilled_orders_today: 3,
  active_orders: 2,
  daily_series: [
    { date: "2026-08-09", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-10", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-11", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-12", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-13", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-14", revenue: 0, fulfilled_orders: 0 },
    { date: "2026-08-15", revenue: 1500, fulfilled_orders: 3 },
  ],
};

describe("Admin dashboard truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchDashboardMetrics.mockResolvedValue(METRICS);
    mocks.getTotpStatus.mockResolvedValue({ totp_enabled: true });
  });

  it("renders payload-derived truthful metrics and series", async () => {
    render(<DashboardPage />);
    expect(await screen.findByText("Today's Revenue")).toBeTruthy();
    expect(screen.getAllByText("₹1,500").length).toBeGreaterThan(0);
    expect(screen.getByText("Fulfilled Orders Today")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Active Orders")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Revenue — last 7 days")).toBeTruthy();
    expect(screen.getByText("2026-08-15")).toBeTruthy();
  });

  it("renders zero-data days as literal zero with no fabricated fallback", async () => {
    render(<DashboardPage />);
    await screen.findByText("Today's Revenue");
    expect(screen.getAllByText("₹0").length).toBeGreaterThanOrEqual(6);
    expect(screen.getAllByText("0 fulfilled").length).toBe(6);
  });

  it("removes all fabricated KPI labels from the dashboard", async () => {
    render(<DashboardPage />);
    await screen.findByText("Today's Revenue");
    for (const gone of [
      "Vendor Churn",
      "Webhook Failures",
      "Avg Pickup Time",
      "CAC (per user)",
      "LTV (6 mo est.)",
      "CAC / LTV",
      "Daily Revenue",
      "2.3%",
      "0.05%",
      "18 min",
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("shows an error state when the metrics fetch fails", async () => {
    mocks.fetchDashboardMetrics.mockRejectedValue(new Error("boom"));
    render(<DashboardPage />);
    expect(await screen.findByText(/Failed to load dashboard/)).toBeTruthy();
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it("shows a loading skeleton until metrics arrive", async () => {
    let resolve!: (v: typeof METRICS) => void;
    mocks.fetchDashboardMetrics.mockReturnValue(
      new Promise<typeof METRICS>((r) => {
        resolve = r;
      }),
    );
    const { container } = render(<DashboardPage />);
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    resolve(METRICS);
    expect(await screen.findByText("Today's Revenue")).toBeTruthy();
  });
});
