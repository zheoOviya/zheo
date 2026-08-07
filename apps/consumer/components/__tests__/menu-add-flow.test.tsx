import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MenuItemsList } from "../MenuItemsList";
import { ToasterHost } from "../ToasterHost";
import { useCartStore } from "@/lib/store";
import type { MenuItem } from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const GREEN_BOWL_ITEMS: MenuItem[] = [
  {
    id: "m-b1",
    restaurant_id: "restB",
    name: "Veg Bowl",
    price: 220,
    dietary_tags: { VEG: true },
    customizations: [],
    is_available: true,
    spice_level: 2,
  },
];

function renderMenu(restaurantId: string, restaurantName: string) {
  return render(
    <>
      <MenuItemsList
        restaurantId={restaurantId}
        restaurantName={restaurantName}
        items={GREEN_BOWL_ITEMS}
      />
      <ToasterHost />
    </>,
  );
}

function openPickerAndConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "Add Veg Bowl" }));
  fireEvent.click(screen.getByRole("button", { name: /Add to Cart/ }));
}

beforeEach(() => {
  useCartStore.setState({ items: [], restaurantId: null, restaurantName: null });
});

describe("cross-restaurant warning + Undo (I-04)", () => {
  it("warns when adding from a different restaurant and restores on Undo", async () => {
    useCartStore.setState({
      items: [
        {
          menuItemId: "m-a1",
          name: "Chicken Biryani",
          basePrice: 350,
          quantity: 2,
          customizations: [],
          restaurantId: "restA",
          restaurantName: "Biryani House",
        },
      ],
      restaurantId: "restA",
      restaurantName: "Biryani House",
    });

    renderMenu("restB", "Green Bowl");
    openPickerAndConfirm();

    await waitFor(
      () =>
        expect(
          screen.getByText(
            /Starting a new order from Green Bowl\. Your 2 items from Biryani House were cleared\./,
          ),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // The new item now owns the cart (single-restaurant rule preserved).
    expect(useCartStore.getState().restaurantId).toBe("restB");
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]!.menuItemId).toBe("m-b1");

    // Undo restores the previous cart exactly.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    const restored = useCartStore.getState();
    expect(restored.restaurantId).toBe("restA");
    expect(restored.restaurantName).toBe("Biryani House");
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]!.menuItemId).toBe("m-a1");
    expect(restored.items[0]!.quantity).toBe(2);
  });

  it("does not warn when adding within the same restaurant", async () => {
    renderMenu("restB", "Green Bowl");
    openPickerAndConfirm();

    await waitFor(
      () => expect(useCartStore.getState().items).toHaveLength(1),
      { timeout: 3000 },
    );
    expect(screen.queryByText(/Starting a new order/)).not.toBeInTheDocument();
    expect(useCartStore.getState().restaurantId).toBe("restB");
  });
});

describe("add-to-cart feedback (I-07)", () => {
  it("shows a spinner (aria-busy) while processing, then a checkmark, then closes", async () => {
    renderMenu("restB", "Green Bowl");
    openPickerAndConfirm();

    // Processing state: spinner + disabled + aria-busy (no duplicate taps).
    expect(
      screen.getByRole("button", { name: /Adding/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Adding/ }),
    ).toHaveAttribute("aria-busy", "true");

    // Success checkmark appears before the picker closes.
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: /Added!/ })).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByRole("button", { name: /Added!/ }),
    ).toBeDisabled();

    // Picker closes once the feedback completes.
    await waitFor(
      () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});
