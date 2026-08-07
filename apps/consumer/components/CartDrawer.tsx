"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore, useCartStore } from "@/lib/store";
import { createGroupCart } from "@/lib/api";
import { computePriceBreakdown, formatINR, itemUnitPrice } from "@/lib/pricing";
import { PriceBreakdown, type BreakdownItem } from "./PriceBreakdown";

// Cart Drawer - slide-up panel showing all items, quantities,
// and an itemized price breakdown for transparency (O10).
// Closes on ESC or backdrop tap; locks body scroll while open.

export function CartDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { items, restaurantId, removeItem, updateQuantity, clear, hydrateFromServer } =
    useCartStore();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [startingGroup, setStartingGroup] = useState(false);
  const breakdown = computePriceBreakdown(items);
  const hydratedRef = useRef(false);

  // O09: on first mount, restore the server-persisted cart so a reload
  // (or another device) never loses the items. Expired carts clear.
  useEffect(() => {
    if (!accessToken || hydratedRef.current) return;
    hydratedRef.current = true;
    void hydrateFromServer(accessToken);
  }, [accessToken, hydrateFromServer]);

  async function handleStartGroupOrder() {
    if (!restaurantId || items.length === 0) return;
    if (!accessToken) {
      router.push("/login");
      return;
    }
    setStartingGroup(true);
    setGroupError(null);
    try {
      const cart = await createGroupCart(accessToken, restaurantId);
      router.push(`/group-cart?token=${encodeURIComponent(cart.group_cart_token)}`);
    } catch (err) {
      setGroupError(
        err instanceof Error ? err.message : "Could not start a group order",
      );
      setStartingGroup(false);
    }
  }

  // ESC to close + body scroll lock while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const itemBreakdowns: BreakdownItem[] = items.map((item) => ({
    label: `${item.name} x${item.quantity}`,
    amount: itemUnitPrice(item) * item.quantity,
  }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your cart"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-auto rounded-t-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-primary-500/20 p-4">
          <h2 className="text-lg font-semibold text-primary-700">
            Your Cart ({breakdown.itemCount})
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cart"
            className="rounded-full p-1 text-neutral-400 hover:text-primary-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {items.length === 0 ? (
          <div className="flex-1 p-8 text-center text-sm text-neutral-400">
            Your cart is empty.
          </div>
        ) : (
          <div className="space-y-3 p-4">
            {items.map((item) => (
              <div
                key={item.menuItemId}
                className="flex items-start justify-between rounded-lg border border-primary-500/10 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-700">
                    {item.name}
                  </p>
                  {item.customizations.length > 0 && (
                    <p className="text-xs text-neutral-400">
                      {item.customizations.map((c) => c.name).join(", ")}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-primary-600">
                    {formatINR(itemUnitPrice(item))} each
                  </p>
                </div>
                <div className="ml-3 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    onClick={() =>
                      updateQuantity(item.menuItemId, item.quantity - 1)
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-light text-sm text-primary-700 hover:bg-primary-500/20"
                  >
                    -
                  </button>
                  <span className="w-6 text-center text-sm font-medium text-neutral-700">
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    onClick={() =>
                      updateQuantity(item.menuItemId, item.quantity + 1)
                    }
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-light text-sm text-primary-700 hover:bg-primary-500/20"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => removeItem(item.menuItemId)}
                    className="ml-1 text-xs text-red-400 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            <PriceBreakdown
              items={itemBreakdowns}
              foodSubtotal={breakdown.foodSubtotal}
              gstFood={breakdown.gstFood}
              packagingFee={breakdown.packagingFee}
              gstPackaging={breakdown.gstPackaging}
              total={breakdown.total}
            />

            <button
              type="button"
              disabled={items.length === 0}
              onClick={() => router.push("/checkout")}
              className="w-full rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              Place Order ({formatINR(breakdown.total)})
            </button>

            <button
              type="button"
              disabled={items.length === 0 || startingGroup}
              onClick={handleStartGroupOrder}
              className="w-full rounded-full border-2 border-primary-500 py-3 text-sm font-semibold text-primary-700 hover:bg-surface-light disabled:opacity-50"
            >
              {startingGroup ? "Starting Group Order..." : "Start Group Order"}
            </button>
            {groupError && (
              <p className="rounded-lg bg-red-50 p-2 text-center text-xs text-red-600">
                {groupError}
              </p>
            )}

            <button
              type="button"
              onClick={clear}
              className="w-full py-2 text-xs text-neutral-400 hover:text-red-500"
            >
              Clear Cart
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
