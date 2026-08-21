import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CartDrawer } from "../CartDrawer";
import { useCartStore, useAuthStore } from "@/lib/store";
import { releaseGift } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createGroupCart: vi.fn(),
    releaseGift: vi.fn(),
    fetchPersistedCart: vi.fn(),
    savePersistedCart: vi.fn().mockResolvedValue({ saved: true, item_count: 2 }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@snakzap/ui", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("../BrandImage", () => ({ BrandImage: () => <div data-testid="brand-image" /> }));

beforeEach(() => {
  useAuthStore.setState({ accessToken: "t", isAuthenticated: true });
  useCartStore.setState({
    items: [
      {
        lineKey: "gift:g1",
        menuItemId: "m1",
        name: "Paneer Wrap",
        basePrice: 0,
        quantity: 1,
        customizations: [],
        restaurantId: "r1",
        giftId: "g1",
        giftToken: "g1",
      },
      {
        lineKey: "m2",
        menuItemId: "m2",
        name: "Cold Coffee",
        basePrice: 120,
        quantity: 1,
        customizations: [],
        restaurantId: "r1",
      },
    ],
    restaurantId: "r1",
    restaurantName: "SnakShack",
  });
});

describe("CartDrawer gift lines", () => {
  it("shows a gift badge and a ₹0 price", () => {
    render(<CartDrawer open onClose={() => {}} />);
    expect(screen.getAllByText("Gift").length).toBeGreaterThan(0);
    expect(screen.getByText("₹0.00 each")).toBeTruthy();
  });

  it("calls releaseGift when removing a gift line", async () => {
    vi.mocked(releaseGift).mockResolvedValue({ id: "g1", status: "ACTIVE" } as never);
    render(<CartDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Paneer Wrap" }));
    await vi.waitFor(() => expect(releaseGift).toHaveBeenCalledWith("t", "g1"));
  });
});
