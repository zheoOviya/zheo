import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OrderHistoryPage from "./page";
import { ToasterHost } from "@/components/ToasterHost";
import { useAuthStore, useCartStore } from "@/lib/store";
import type { OrderHistoryEntry } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  fetchOrderHistory: vi.fn(),
  fetchOrderById: vi.fn(),
  reorderOrder: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchOrderHistory: mocks.fetchOrderHistory,
  fetchOrderById: mocks.fetchOrderById,
  reorderOrder: mocks.reorderOrder,
  clearPersistedCart: vi.fn(() => Promise.resolve({ cleared: true })),
  savePersistedCart: vi.fn(() =>
    Promise.resolve({ saved: true, item_count: 0 }),
  ),
  fetchPersistedCart: vi.fn(() =>
    Promise.resolve({
      items: [],
      expired: false,
      saved_at: null,
      restaurant_id: null,
      restaurant_name: null,
    }),
  ),
}));

vi.mock("@/components/AuthGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}));

const ORDER: OrderHistoryEntry = {
  id: "order-1",
  user_id: "u1",
  restaurant_id: "rest-1",
  restaurant_name: "Biryani House",
  status: "CONFIRMED",
  total_amount: 450,
  commission_rate: 0.1,
  commission_amount: 45,
  pickup_otp: null,
  qr_token: null,
  checked_in: false,
  scheduled_pickup_time: null,
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
  items: [
    {
      id: "i1",
      menu_item_id: "m1",
      name: "Chicken Biryani",
      base_price: 350,
      quantity: 1,
      customizations: [],
      customization_total: 0,
      item_subtotal: 350,
    },
    {
      id: "i2",
      menu_item_id: "m2",
      name: "Raita",
      base_price: 100,
      quantity: 1,
      customizations: [],
      customization_total: 0,
      item_subtotal: 100,
    },
  ],
};

function renderPage() {
  return render(
    <>
      <OrderHistoryPage />
      <ToasterHost />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    accessToken: "test-token",
    user: { id: "u1", phone: "+919000000000", role: "CONSUMER" },
    isAuthenticated: true,
  });
  useCartStore.setState({ items: [], restaurantId: null, restaurantName: null });
});

describe("Order History page (I-03)", () => {
  it("renders skeletons with aria-busy while loading", () => {
    mocks.fetchOrderHistory.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status", { name: "Loading your orders" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("renders order cards after the fetch resolves", async () => {
    mocks.fetchOrderHistory.mockResolvedValue({
      orders: [ORDER],
      page: 1,
      limit: 10,
      total: 1,
      pages: 1,
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Biryani House")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Chicken Biryani x1, Raita x1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("₹450.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder" })).toBeInTheDocument();
    expect(mocks.fetchOrderHistory).toHaveBeenCalledWith("test-token", 1, 10);
  });

  it("shows an empty state when there are no orders", async () => {
    mocks.fetchOrderHistory.mockResolvedValue({
      orders: [],
      page: 1,
      limit: 10,
      total: 0,
      pages: 1,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No orders yet")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "Browse Restaurants" }),
    ).toBeInTheDocument();
  });

  it("shows an error state and lets the user retry", async () => {
    mocks.fetchOrderHistory
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce({
        orders: [ORDER],
        page: 1,
        limit: 10,
        total: 1,
        pages: 1,
      });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Network down")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByText("Biryani House")).toBeInTheDocument(),
    );
  });

  it("reorders: re-places the order and pre-fills the cart", async () => {
    mocks.fetchOrderHistory.mockResolvedValue({
      orders: [ORDER],
      page: 1,
      limit: 10,
      total: 1,
      pages: 1,
    });
    mocks.reorderOrder.mockResolvedValue({
      id: "order-new",
      status: "DRAFT",
      total_amount: 450,
    });
    mocks.fetchOrderById.mockResolvedValue(ORDER);
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reorder" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reorder" }));

    await waitFor(() =>
      expect(mocks.reorderOrder).toHaveBeenCalledWith("test-token", "order-1"),
    );
    expect(mocks.fetchOrderById).toHaveBeenCalledWith("test-token", "order-1");

    const cart = useCartStore.getState();
    expect(cart.items).toHaveLength(2);
    expect(cart.restaurantId).toBe("rest-1");
    expect(cart.restaurantName).toBe("Biryani House");
    expect(cart.items[0]!.name).toBe("Chicken Biryani");

    await waitFor(() =>
      expect(
        screen.getByText("Order placed. Items added to your cart."),
      ).toBeInTheDocument(),
    );
  });

  it("paginates when there are multiple pages", async () => {
    mocks.fetchOrderHistory.mockImplementation((_token, page) =>
      Promise.resolve({
        orders: [ORDER],
        page,
        limit: 1,
        total: 3,
        pages: 3,
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Previous/ }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(screen.getByText("Page 2 of 3")).toBeInTheDocument(),
    );
    expect(mocks.fetchOrderHistory).toHaveBeenCalledWith("test-token", 2, 10);
  });
});
