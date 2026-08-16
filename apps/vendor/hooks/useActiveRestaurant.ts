"use client";

import { useEffect } from "react";
import { useVendorStore } from "@/lib/store";

// ============================================
// Loads and exposes the vendor's active restaurant.
// Data pages call this and wait for `activeRestaurantId`
// before issuing scoped API calls (orders, menu, etc.).
// ============================================

export function useActiveRestaurant() {
  const activeRestaurantId = useVendorStore((s) => s.activeRestaurantId);
  const restaurants = useVendorStore((s) => s.restaurants);
  const status = useVendorStore((s) => s.status);
  const error = useVendorStore((s) => s.error);
  const load = useVendorStore((s) => s.load);
  const setActiveRestaurantId = useVendorStore((s) => s.setActiveRestaurantId);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  return { activeRestaurantId, restaurants, status, error, setActiveRestaurantId };
}
