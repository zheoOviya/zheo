"use client";

import { create } from "zustand";
import { fetchVendorRestaurants, type VendorRestaurant } from "./api";

// ============================================
// Vendor restaurant state.
// After sign-in the shell loads the restaurants the vendor is authorized to
// operate (GET /api/vendor/restaurants) and keeps the "active" restaurant
// here. Every data page reads `activeRestaurantId` instead of assuming a
// fixed seed id, so multi-outlet vendors can switch restaurants.
// ============================================

export interface VendorStoreState {
  restaurants: VendorRestaurant[];
  activeRestaurantId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
  setActiveRestaurantId: (id: string) => void;
  reset: () => void;
}

export const useVendorStore = create<VendorStoreState>((set, get) => ({
  restaurants: [],
  activeRestaurantId: null,
  status: "idle",
  error: null,

  async load() {
    if (get().status === "loading" || get().status === "ready") return;
    set({ status: "loading", error: null });
    try {
      const restaurants = await fetchVendorRestaurants();
      const current = get().activeRestaurantId;
      const nextActive =
        current && restaurants.some((r) => r.id === current)
          ? current
          : (restaurants.find((r) => r.is_active) ?? restaurants[0])?.id ?? null;
      set({ restaurants, activeRestaurantId: nextActive, status: "ready" });
    } catch (err) {
      set({
        status: "error",
        error: err instanceof Error ? err.message : "Failed to load restaurants",
      });
    }
  },

  setActiveRestaurantId(id) {
    set({ activeRestaurantId: id });
  },

  reset() {
    set({ restaurants: [], activeRestaurantId: null, status: "idle", error: null });
  },
}));
