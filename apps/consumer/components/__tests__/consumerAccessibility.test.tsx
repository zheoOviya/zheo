import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CartDrawer } from "../CartDrawer";
import { useCartStore, useAuthStore } from "@/lib/store";

// ============================================
// CONSUMER_UI-A2a — dialog / icon regression coverage (CA-7, CA-8, CA-9).
//
// These surfaces are already compliant at the frozen baseline. This suite
// only locks the existing semantics so a future refactor cannot silently
// regress them. No production dialog file is modified by A2a.
//
// Source/behavior only: no git history, no checkout depth, no working-tree.
// ============================================

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  useAuthStore.setState({ accessToken: null, isAuthenticated: false });
  useCartStore.setState({
    items: [
      {
        lineKey: "m1",
        menuItemId: "m1",
        name: "Paneer Wrap",
        basePrice: 120,
        quantity: 2,
        customizations: [],
        restaurantId: "r1",
      },
    ],
    restaurantId: "r1",
    restaurantName: "SnakShack",
  });
});

describe("consumer dialog and icon accessibility regressions", () => {
  it("CA-7 exposes drawer dialog semantics with an accessible name", () => {
    render(<CartDrawer open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Your cart" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("CA-8 exposes the close icon control by accessible name", () => {
    render(<CartDrawer open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close cart" })).toBeTruthy();
  });

  it("CA-9 exposes icon-only commerce controls by accessible name", () => {
    render(<CartDrawer open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Paneer Wrap" })).toBeTruthy();
  });
});
