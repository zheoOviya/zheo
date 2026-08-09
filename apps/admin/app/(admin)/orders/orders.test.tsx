// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OrdersPage from "./page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  fetchLiveOrders: vi.fn(),
  fetchOrderDetail: vi.fn(),
  overrideOrderStatus: vi.fn(),
}));

vi.mock("../../../lib/api", () => mocks);

const LIVE_ORDERS = {
  orders: [
    {
      id: "a0000000-0000-4000-8000-000000000001",
      status: "PREPARING",
      total_amount: 250,
      created_at: "2026-08-09T10:00:00.000Z",
    },
  ],
  total: 1,
  statusCounts: { PREPARING: 1 },
};

const DETAIL = {
  id: "a0000000-0000-4000-8000-000000000001",
  status: "PREPARING",
  total_amount: 250,
  user_id: "u00000000-0000-4000-8000-000000000001",
  restaurant_id: "a0000000-0000-4000-8000-000000000001",
  created_at: "2026-08-09T10:00:00.000Z",
};

describe("Admin orders page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchLiveOrders.mockResolvedValue(LIVE_ORDERS);
    mocks.fetchOrderDetail.mockResolvedValue(DETAIL);
    mocks.overrideOrderStatus.mockResolvedValue({});
  });

  it("renders live orders from the API", async () => {
    render(<OrdersPage />);
    expect(await screen.findByText("PREPARING")).toBeTruthy();
    expect(screen.getByText(/Rs\.250/)).toBeTruthy();
  });

  it("shows order detail after expanding a row (loading flag resets)", async () => {
    render(<OrdersPage />);
    await screen.findByText("PREPARING");

    fireEvent.click(screen.getByText("Detail"));

    expect(await screen.findByText("User ID:")).toBeTruthy();
    expect(screen.getByText(/u00000000-.*\.\.\./)).toBeTruthy();
  });

  it("collapses detail when toggling back", async () => {
    render(<OrdersPage />);
    await screen.findByText("PREPARING");

    fireEvent.click(screen.getByText("Detail"));
    await screen.findByText("User ID:");

    fireEvent.click(screen.getByText("Hide"));
    expect(screen.queryByText("User ID:")).toBeNull();
  });
});
