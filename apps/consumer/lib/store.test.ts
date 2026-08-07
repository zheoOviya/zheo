import { describe, it, expect, beforeEach } from "vitest";
import { useCartStore, useAuthStore } from "./store";

import { describe as vitestDescribe } from "vitest";

describe("Cart store", () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [],
      restaurantId: null,
      restaurantName: null,
    });
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
    });
  });

  it("adds an item to an empty cart", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Butter Chicken",
      basePrice: 350,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });

    const state = useCartStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.restaurantId).toBe("rest-1");
    expect(state.items[0]!.name).toBe("Butter Chicken");
  });

  it("increments quantity when adding the same menu item", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Naan",
      basePrice: 40,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Naan",
      basePrice: 40,
      quantity: 2,
      customizations: [],
      restaurantId: "rest-1",
    });

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]!.quantity).toBe(3);
  });

  it("replaces cart when adding item from a different restaurant", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Pizza",
      basePrice: 300,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().restaurantId).toBe("rest-1");

    useCartStore.getState().addItem({
      menuItemId: "item-2",
      name: "Burger",
      basePrice: 200,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-2",
    });

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().restaurantId).toBe("rest-2");
    expect(useCartStore.getState().items[0]!.name).toBe("Burger");
  });

  it("allows undo by restoring previous cart state", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Pizza",
      basePrice: 300,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });

    const prevItems = [...useCartStore.getState().items];
    const prevRestaurantId = useCartStore.getState().restaurantId;
    const prevRestaurantName = useCartStore.getState().restaurantName;

    useCartStore.getState().addItem({
      menuItemId: "item-2",
      name: "Burger",
      basePrice: 200,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-2",
    });

    expect(useCartStore.getState().restaurantId).toBe("rest-2");

    useCartStore.setState({
      items: prevItems,
      restaurantId: prevRestaurantId,
      restaurantName: prevRestaurantName,
    });

    expect(useCartStore.getState().restaurantId).toBe("rest-1");
    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]!.name).toBe("Pizza");
  });

  it("clears cart correctly", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Coffee",
      basePrice: 150,
      quantity: 2,
      customizations: [],
      restaurantId: "rest-1",
    });

    useCartStore.getState().clear();

    expect(useCartStore.getState().items).toHaveLength(0);
    expect(useCartStore.getState().restaurantId).toBeNull();
  });

  it("computes item count correctly", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Item 1",
      basePrice: 100,
      quantity: 2,
      customizations: [],
      restaurantId: "rest-1",
    });
    useCartStore.getState().addItem({
      menuItemId: "item-2",
      name: "Item 2",
      basePrice: 200,
      quantity: 3,
      customizations: [],
      restaurantId: "rest-1",
    });

    expect(useCartStore.getState().itemCount()).toBe(5);
  });

  it("computes subtotal with customizations", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Item",
      basePrice: 200,
      quantity: 2,
      customizations: [
        { name: "Extra Cheese", price_delta: 50 },
        { name: "Spicy", price_delta: 10 },
      ],
      restaurantId: "rest-1",
    });

    expect(useCartStore.getState().subtotal()).toBe(520);
  });

  it("removes item by menuItemId", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Item 1",
      basePrice: 100,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });
    useCartStore.getState().addItem({
      menuItemId: "item-2",
      name: "Item 2",
      basePrice: 200,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });

    useCartStore.getState().removeItem("item-1");

    expect(useCartStore.getState().items).toHaveLength(1);
    expect(useCartStore.getState().items[0]!.name).toBe("Item 2");
  });

  it("removing last item clears restaurantId", () => {
    useCartStore.getState().addItem({
      menuItemId: "item-1",
      name: "Item 1",
      basePrice: 100,
      quantity: 1,
      customizations: [],
      restaurantId: "rest-1",
    });

    useCartStore.getState().removeItem("item-1");

    expect(useCartStore.getState().items).toHaveLength(0);
    expect(useCartStore.getState().restaurantId).toBeNull();
  });
});
