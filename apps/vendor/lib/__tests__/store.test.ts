import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVendorStore } from "../store";
import type { VendorRestaurant } from "../api";

const mocks = vi.hoisted(() => ({
  fetchVendorRestaurants: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchVendorRestaurants: mocks.fetchVendorRestaurants,
}));

function restaurant(overrides: Partial<VendorRestaurant> = {}): VendorRestaurant {
  return {
    id: "r1",
    name: "Biryani House",
    is_active: true,
    commission_rate: 0.08,
    chain_id: null,
    ...overrides,
  };
}

describe("vendor restaurant store", () => {
  beforeEach(() => {
    useVendorStore.getState().reset();
    vi.clearAllMocks();
  });

  it("loads restaurants and selects the first active one", async () => {
    mocks.fetchVendorRestaurants.mockResolvedValue([
      restaurant({ id: "r1", name: "Biryani House", is_active: false }),
      restaurant({ id: "r2", name: "Green Bowl", is_active: true }),
    ]);

    await useVendorStore.getState().load();

    const state = useVendorStore.getState();
    expect(state.status).toBe("ready");
    expect(state.restaurants).toHaveLength(2);
    expect(state.activeRestaurantId).toBe("r2");
  });

  it("keeps the current active restaurant when it is still available", async () => {
    useVendorStore.getState().setActiveRestaurantId("r1");
    mocks.fetchVendorRestaurants.mockResolvedValue([
      restaurant({ id: "r1" }),
      restaurant({ id: "r2", name: "Green Bowl" }),
    ]);

    await useVendorStore.getState().load();

    expect(useVendorStore.getState().activeRestaurantId).toBe("r1");
  });

  it("switches the active restaurant", () => {
    useVendorStore.getState().setActiveRestaurantId("r2");
    expect(useVendorStore.getState().activeRestaurantId).toBe("r2");
  });

  it("resets to an empty idle state", async () => {
    mocks.fetchVendorRestaurants.mockResolvedValue([restaurant()]);
    await useVendorStore.getState().load();
    expect(useVendorStore.getState().activeRestaurantId).toBe("r1");

    useVendorStore.getState().reset();
    expect(useVendorStore.getState().status).toBe("idle");
    expect(useVendorStore.getState().restaurants).toHaveLength(0);
    expect(useVendorStore.getState().activeRestaurantId).toBeNull();
  });

  it("records an error when the fetch fails", async () => {
    mocks.fetchVendorRestaurants.mockRejectedValue(new Error("network down"));
    await useVendorStore.getState().load();
    expect(useVendorStore.getState().status).toBe("error");
    expect(useVendorStore.getState().error).toBe("network down");
  });
});
