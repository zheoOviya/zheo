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
  commission_amount: 25,
  user_id: "u00000000-0000-4000-8000-000000000001",
  restaurant_id: "a0000000-0000-4000-8000-000000000001",
  created_at: "2026-08-09T10:00:00.000Z",
  items: [
    {
      id: "i00000000-0000-4000-8000-000000000001",
      menu_item_id: "m1",
      name: "Butter Chicken",
      base_price: 200,
      quantity: 1,
      customizations: [],
      customization_total: 0,
      item_subtotal: 200,
    },
  ],
  payment: {
    id: "p00000000-0000-4000-8000-000000000001",
    status: "CAPTURED",
    method: "upi",
    amount: 250,
    currency: "INR",
    razorpay_order_id: "rp_1",
    razorpay_payment_id: "pay_1",
    created_at: "2026-08-09T10:00:00.000Z",
  },
  customer: {
    id: "u00000000-0000-4000-8000-000000000001",
    phone: "+919876000111",
    role: "CONSUMER",
    is_suspended: false,
  },
  restaurant: {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Biryani House",
    commission_rate: 0.08,
  },
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

    expect(await screen.findByText("Customer:")).toBeTruthy();
    expect(screen.getByText("+919876000111")).toBeTruthy();
  });

  it("shows items, payment, and restaurant in the detail panel", async () => {
    render(<OrdersPage />);
    await screen.findByText("PREPARING");

    fireEvent.click(screen.getByText("Detail"));
    await screen.findByText("Customer:");

    expect(screen.getByText("Butter Chicken")).toBeTruthy();
    expect(screen.getByText("Biryani House")).toBeTruthy();
    expect(screen.getByText("CAPTURED")).toBeTruthy();
    expect(screen.getByText("UPI")).toBeTruthy();
  });

  it("collapses detail when toggling back", async () => {
    render(<OrdersPage />);
    await screen.findByText("PREPARING");

    fireEvent.click(screen.getByText("Detail"));
    await screen.findByText("Customer:");

    fireEvent.click(screen.getByText("Hide"));
    expect(screen.queryByText("Customer:")).toBeNull();
  });
});
