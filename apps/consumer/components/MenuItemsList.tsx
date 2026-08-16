"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import toast, { type Toast } from "react-hot-toast";
import type { MenuItem } from "@/lib/api";
import {
  useCartStore,
  type CartCustomization,
  type CartItem,
  type AddItemResult,
} from "@/lib/store";
import { computePriceBreakdown, formatINR, itemUnitPrice } from "@/lib/pricing";
import { ADD_PROCESSING_MS, ADD_SUCCESS_MS } from "@/lib/addFeedback";
import { CustomizationPicker } from "./CustomizationPicker";
import { CartDrawer } from "./CartDrawer";

// ============================================
// Menu items client island. Owns the 3-tap flow:
// 1. Tap an item -> 2. Pick customizations -> 3. Add to cart.
// A floating "View Cart" bar surfaces the drawer once items exist.
// Sprint 1:
// - I-04 cross-restaurant add warns via toast + "Undo" restores the cart.
// - I-07 confirm button shows spinner (aria-busy) then a green checkmark;
//   duplicate taps are dropped while an add is in flight.
// ============================================

const DIETARY_COLORS: Record<string, string> = {
  VEG: "bg-green-500/15 text-green-700 ring-green-600/20",
  NON_VEG: "bg-red-500/15 text-red-700 ring-red-600/20",
  JAIN: "bg-primary-500/15 text-primary-700 ring-primary-600/20",
};

function toCustomizations(raw: unknown[] | undefined): CartCustomization[] {
  return (raw ?? [])
    .map((c) => c as { name?: unknown; price_delta?: unknown })
    .filter(
      (c): c is CartCustomization =>
        typeof c.name === "string" && typeof c.price_delta === "number",
    )
    .map((c) => ({ name: c.name, price_delta: c.price_delta }));
}

/** I-04 warning toast: the old cart was cleared to start a new restaurant. */
function warnCrossRestaurant(result: Extract<AddItemResult, { cleared: true }>, newName: string) {
  toast(
    (t: Toast) => (
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-snug text-neutral-700">
          Starting a new order from {newName}. Your {result.clearedItemCount} item
          {result.clearedItemCount === 1 ? "" : "s"} from{" "}
          {result.previousRestaurantName ?? "your last restaurant"} were cleared.
        </p>
        <button
          type="button"
          onClick={() => {
            useCartStore.getState().restoreSnapshot(result.snapshot);
            toast.dismiss(t.id);
          }}
          className="shrink-0 rounded-full bg-primary-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-hover"
        >
          Undo
        </button>
      </div>
    ),
    { duration: 6000 },
  );
}

export function MenuItemsList({
  restaurantId,
  restaurantName,
  items,
}: {
  restaurantId: string;
  restaurantName: string;
  items: MenuItem[];
}) {
  const { items: cartItems, addItem, itemCount } = useCartStore();
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const addingRef = useRef(false);

  const count = itemCount();
  const breakdown = computePriceBreakdown(cartItems);

  const handleAdd = useCallback(
    (item: MenuItem, customizations: CartCustomization[]) => {
      if (addingRef.current) return;
      addingRef.current = true;
      setAdding(true);
      setAdded(false);

      const cartItem: CartItem = {
        menuItemId: item.id,
        name: item.name,
        basePrice: item.price,
        quantity: 1,
        customizations,
        restaurantId,
        restaurantName,
      };

      // I-07: minimum visual processing time so the spinner is perceivable,
      // then a short green checkmark before the picker closes.
      window.setTimeout(() => {
        const result = addItem(cartItem);
        setAdding(false);
        setAdded(true);

        window.setTimeout(() => {
          addingRef.current = false;
          setAdded(false);
          setPickerItem(null);
          setJustAddedId(item.id);
          window.setTimeout(() => setJustAddedId(null), ADD_SUCCESS_MS);
          if (result.cleared) {
            warnCrossRestaurant(result, restaurantName);
          }
        }, ADD_SUCCESS_MS);
      }, ADD_PROCESSING_MS);
    },
    [addItem, restaurantId, restaurantName],
  );

  const available = items.filter((i) => i.is_available);
  const unavailable = items.filter((i) => !i.is_available);

  return (
    <>
      <div className="space-y-3">
        {available.map((item) => {
          const unitPrice = itemUnitPrice({
            basePrice: item.price,
            quantity: 1,
            customizations: toCustomizations(item.customizations),
          });
          const tags = Object.entries(item.dietary_tags ?? {})
            .filter(([, on]) => on)
            .map(([tag]) => tag);
          const isJustAdded = justAddedId === item.id;

          return (
            <div key={item.id} className="surface-card flex items-center gap-3.5 p-3.5">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-primary-100 dark:bg-primary-900/30">
                <Image
                  src={item.image_url ?? `https://picsum.photos/seed/${item.id}/160/160`}
                  alt=""
                  fill
                  sizes="64px"
                  loading="lazy"
                  className="object-cover"
                />
                {tags[0] && (
                  <span
                    aria-label={tags[0]}
                    aria-hidden="false"
                    className={`absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-white ${
                      tags[0] === "NON_VEG" ? "bg-red-600" : "bg-green-600"
                    }`}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="line-clamp-1 text-sm font-bold tracking-tight text-neutral-900 dark:text-white">
                    {item.name}
                  </h3>
                  {tags.slice(1).map((tag) => (
                    <span
                      key={tag}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-bold uppercase ring-1 ${
                        DIETARY_COLORS[tag] ??
                        "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300"
                      }`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-sm font-extrabold text-primary-700 dark:text-primary-300">
                  {formatINR(unitPrice)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerItem(item)}
                aria-label={isJustAdded ? `Added ${item.name}` : `Add ${item.name}`}
                className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold text-white transition-transform active:scale-95 ${
                  isJustAdded ? "bg-green-500" : "bg-primary-500 hover:bg-primary-hover"
                }`}
              >
                {isJustAdded ? (
                  <svg
                    className="mx-auto h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  "Add +"
                )}
              </button>
            </div>
          );
        })}

        {unavailable.length > 0 && (
          <div className="surface-card bg-white/60 p-4 dark:bg-neutral-900/60">
            <h4 className="text-sm font-semibold text-neutral-400 dark:text-neutral-500">
              Currently unavailable
            </h4>
            <ul className="mt-2 space-y-1">
              {unavailable.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between text-sm text-neutral-300 dark:text-neutral-600"
                >
                  <span>{item.name}</span>
                  <span>{formatINR(item.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {available.length === 0 && unavailable.length === 0 && (
          <p className="surface-card py-10 text-center text-sm text-neutral-400">
            No items on the menu right now.
          </p>
        )}
      </div>

      {pickerItem && (
        <CustomizationPicker
          itemName={pickerItem.name}
          basePrice={pickerItem.price}
          availableCustomizations={toCustomizations(pickerItem.customizations)}
          pending={adding}
          success={added}
          onConfirm={(selected) => handleAdd(pickerItem, selected)}
          onCancel={() => {
            if (!addingRef.current) setPickerItem(null);
          }}
        />
      )}

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />

      {count > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-3">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            aria-label={`View cart, ${count} item${count === 1 ? "" : "s"}, total ${formatINR(breakdown.total)}`}
            className="pointer-events-auto flex w-full items-center justify-between rounded-2xl bg-gradient-to-r from-primary-700 to-primary-600 px-6 py-4 text-white shadow-elevation-3 shadow-primary-900/30 transition-transform hover:from-primary-800 hover:to-primary-700 active:scale-[0.99]"
          >
            <span className="flex items-center gap-2.5 text-sm font-bold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-xs">
                {count}
              </span>
              View Cart
            </span>
            <span className="flex items-center gap-1.5 text-sm font-extrabold">
              {formatINR(breakdown.total)}
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </button>
        </div>
      )}
    </>
  );
}
