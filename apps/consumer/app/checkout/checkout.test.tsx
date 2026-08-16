import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CheckoutPage from "./page";
import { useAuthStore, useCartStore } from "@/lib/store";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

describe("CheckoutPage", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "tok-123",
      user: { id: "u1", phone: "9876543210", role: "CONSUMER" },
      isAuthenticated: true,
    });
    useCartStore.setState({
      items: [
        {
          menuItemId: "m1",
          name: "Paneer Tikka",
          basePrice: 200,
          quantity: 1,
          customizations: [],
          restaurantId: "r1",
          restaurantName: "Spice Route",
        },
      ],
      restaurantId: "r1",
      restaurantName: "Spice Route",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers payment and continue-shopping without a sign-out action", async () => {
    render(<CheckoutPage />);

    expect(await screen.findByText(/Place Pickup Order/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Continue Shopping/ })).toBeDefined();

    expect(screen.queryByRole("button", { name: "Sign Out" })).toBeNull();
    expect(screen.queryByText("Sign Out")).toBeNull();
  });

  it("renders the global header with the account menu", async () => {
    render(<CheckoutPage />);

    expect(screen.getByRole("link", { name: "SnakZap home" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
  });

  it("shows the suspension banner for a suspended account", async () => {
    useAuthStore.setState({
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: true },
    });

    render(<CheckoutPage />);

    expect(await screen.findByText(/suspended/)).toBeDefined();
  });
});
