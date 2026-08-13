import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MenuItemsList } from "./MenuItemsList";
import { ToasterHost } from "./ToasterHost";
import { useCartStore } from "@/lib/store";
import type { MenuItem } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const ITEMS: MenuItem[] = [
  {
    id: "m-1",
    restaurant_id: "restA",
    name: "Veg Bowl",
    price: 220,
    image_url: null,
    dietary_tags: { VEG: true },
    customizations: [],
    is_available: true,
    spice_level: 2,
  },
];

function renderMenu() {
  return render(
    <>
      <MenuItemsList restaurantId="restA" restaurantName="Bowl House" items={ITEMS} />
      <ToasterHost />
    </>,
  );
}

beforeEach(() => {
  useCartStore.setState({ items: [], restaurantId: null, restaurantName: null });
});

describe("MenuItemsList", () => {
  it("renders menu items with dietary tags", () => {
    renderMenu();
    expect(screen.getByText("Veg Bowl")).toBeTruthy();
    expect(screen.getByLabelText("VEG")).toBeTruthy();
  });

  it("adds an item to the cart and surfaces the floating cart bar", async () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: "Add Veg Bowl" }));
    fireEvent.click(screen.getByRole("button", { name: /Add to Cart/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /View cart, 1 item, total/ })).toBeTruthy();
    });
  });
});
