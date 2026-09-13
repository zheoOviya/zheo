// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  async function expandFirstOrder() {
    render(<OrdersPage />);
    await screen.findByText("PREPARING");
    fireEvent.click(screen.getByText("Detail"));
    await screen.findByText("Customer:");
  }

  it("F1 does not offer SETTLED as an override target", async () => {
    await expandFirstOrder();
    expect(screen.queryByRole("option", { name: "SETTLED" })).toBeNull();
  });

  it("F2 sends the current order status as from_status", async () => {
    await expandFirstOrder();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ALMOST_READY" } });
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    await waitFor(() =>
      expect(mocks.overrideOrderStatus).toHaveBeenCalledWith(
        LIVE_ORDERS.orders[0]!.id,
        "ALMOST_READY",
        "PREPARING",
        undefined,
        false,
      ),
    );
  });

  it("F3 sends force=true when the force control is set", async () => {
    await expandFirstOrder();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ALMOST_READY" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByPlaceholderText("Reason..."), { target: { value: "expedite" } });
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    await waitFor(() =>
      expect(mocks.overrideOrderStatus).toHaveBeenCalledWith(
        LIVE_ORDERS.orders[0]!.id,
        "ALMOST_READY",
        "PREPARING",
        "expedite",
        true,
      ),
    );
  });

  it("F4 blocks a force override without a reason", async () => {
    await expandFirstOrder();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ALMOST_READY" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const btn = screen.getByRole("button", { name: "Override" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(mocks.overrideOrderStatus).not.toHaveBeenCalled();
  });

  it("F5 surfaces a 409 stale-write error", async () => {
    mocks.overrideOrderStatus.mockRejectedValueOnce(
      new Error("Order status has changed; re-read and retry"),
    );
    await expandFirstOrder();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ALMOST_READY" } });
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(await screen.findByText("Order status has changed; re-read and retry")).toBeTruthy();
  });

  it("F6 normal non-force override keeps force=false", async () => {
    await expandFirstOrder();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ALMOST_READY" } });
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    await waitFor(() => expect(mocks.overrideOrderStatus).toHaveBeenCalledTimes(1));
    expect(mocks.overrideOrderStatus.mock.calls[0]![4]).toBe(false);
  });
});
