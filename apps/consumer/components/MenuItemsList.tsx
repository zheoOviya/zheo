"use client";

import { useState, useCallback } from "react";
import type { MenuItem } from "@/lib/api";
import { useCartStore, type CartCustomization } from "@/lib/store";
import { computePriceBreakdown, formatINR, itemUnitPrice } from "@/lib/pricing";
import { CustomizationPicker } from "./CustomizationPicker";
import { CartDrawer } from "./CartDrawer";

// ============================================
// Menu items client island. Owns the 3-tap flow:
// 1. Tap an item -> 2. Pick customizations -> 3. Add to cart.
// A floating "View Cart" bar surfaces the drawer once items exist.
// ============================================

const DIETARY_COLORS: Record<string, string> = {
  VEG: "bg-green-500/15 text-green-700 ring-green-600/20",
  NON_VEG: "bg-red-500/15 text-red-700 ring-red-600/20",
  JAIN: "bg-primary-500/15 text-primary-700 ring-primary-600/20",
  HALAL: "bg-amber-500/15 text-amber-700 ring-amber-600/20",
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

export function MenuItemsList({
  restaurantId,
  items,
}: {
  restaurantId: string;
  items: MenuItem[];
}) {
  const { items: cartItems, addItem, itemCount } = useCartStore();
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

  const count = itemCount();
  const breakdown = computePriceBreakdown(cartItems);

  const handleAdd = useCallback(
    (item: MenuItem, customizations: CartCustomization[]) => {
      addItem({
        menuItemId: item.id,
        name: item.name,
        basePrice: item.price,
        quantity: 1,
        customizations,
        restaurantId,
      });
      setPickerItem(null);
    },
    [addItem, restaurantId],
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

          return (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm"
            >
              <div className="min-w-0 flex-1 pr-3">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-semibold text-neutral-800">
                    {item.name}
                  </h3>
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ring-1 ${
                        DIETARY_COLORS[tag] ?? "bg-neutral-500/10 text-neutral-600"
                      }`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-sm font-semibold text-primary-600">
                  {formatINR(unitPrice)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerItem(item)}
                className="shrink-0 rounded-full bg-primary-500 px-5 py-2 text-sm font-bold text-white hover:bg-primary-hover active:scale-95 transition-transform"
              >
                Add +
              </button>
            </div>
          );
        })}

        {unavailable.length > 0 && (
          <div className="rounded-2xl bg-white/60 p-4 shadow-sm">
            <h4 className="text-sm font-semibold text-neutral-400">
              Currently unavailable
            </h4>
            <ul className="mt-2 space-y-1">
              {unavailable.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between text-sm text-neutral-300"
                >
                  <span>{item.name}</span>
                  <span>{formatINR(item.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {available.length === 0 && unavailable.length === 0 && (
          <p className="rounded-2xl bg-white py-10 text-center text-sm text-neutral-400">
            No items on the menu right now.
          </p>
        )}
      </div>

      {pickerItem && (
        <CustomizationPicker
          itemName={pickerItem.name}
          basePrice={pickerItem.price}
          availableCustomizations={toCustomizations(pickerItem.customizations)}
          onConfirm={(selected) => handleAdd(pickerItem, selected)}
          onCancel={() => setPickerItem(null)}
        />
      )}

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-5xl px-4 pb-4">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex w-full items-center justify-between rounded-full bg-primary-700 px-6 py-4 text-white shadow-lg shadow-primary-900/30 hover:bg-primary-800 active:scale-[0.99] transition-transform"
          >
            <span className="text-sm font-semibold">
              View Cart · {count} item{count === 1 ? "" : "s"}
            </span>
            <span className="text-sm font-bold">{formatINR(breakdown.total)}</span>
          </button>
        </div>
      )}
    </>
  );
}
