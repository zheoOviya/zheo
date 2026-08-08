"use client";

import { Toaster, toast } from "react-hot-toast";
import type { Toast as ToastType } from "react-hot-toast";
import { useEffect, useRef } from "react";
import { useCartStore, type CartItem } from "@/lib/store";

function CartToastListener() {
  const prevRestaurantRef = useRef<string | null>(null);
  const prevItemsRef = useRef<CartItem[]>([]);

  useEffect(() => {
    return useCartStore.subscribe((state, prevState) => {
      const prevRestaurantId = prevRestaurantRef.current ?? prevState.restaurantId;
      const newRestaurantId = state.restaurantId;

      if (
        prevRestaurantId &&
        newRestaurantId &&
        prevRestaurantId !== newRestaurantId &&
        prevState.items.length > 0 &&
        state.items.length > 0
      ) {
        const oldItems = [...prevState.items];
        toast(
          (t: ToastType) => (
            <div className="flex items-center gap-3">
              <p className="text-sm">
                Cart cleared &mdash; you switched restaurants.
              </p>
              <button
                type="button"
                onClick={() => {
                  useCartStore.setState({
                    items: oldItems,
                    restaurantId: prevRestaurantId,
                    restaurantName: prevState.restaurantName,
                  });
                  toast.dismiss(t.id);
                  toast.success("Previous cart restored.", { duration: 2000 });
                }}
                className="shrink-0 rounded-full bg-primary-500 px-3 py-1 text-xs font-semibold text-white hover:bg-primary-hover"
              >
                Undo
              </button>
            </div>
          ),
          { duration: 5000, id: "cart-restaurant-switch" },
        );
      }

      prevRestaurantRef.current = newRestaurantId;
      prevItemsRef.current = state.items;
    });
  }, []);

  return null;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <CartToastListener />
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: "#1e293b",
            color: "#f8fafc",
            borderRadius: "1rem",
            fontSize: "0.875rem",
          },
          success: {
            style: {
              background: "#065f46",
              color: "#ecfdf5",
            },
          },
        }}
      />
    </>
  );
}
