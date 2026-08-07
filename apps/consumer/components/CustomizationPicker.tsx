"use client";

import { useEffect, useState } from "react";
import type { CartCustomization } from "@/lib/store";
import { formatINR } from "@/lib/pricing";

// O06 Customization Picker - bottom sheet for selecting add-ons.
// Live price updates as customizations are toggled. 3-tap flow:
// 1. Tap item in menu, 2. Pick customizations, 3. Tap Add to Cart.
// Closes on ESC or backdrop tap; locks body scroll while open.

interface CustomizationPickerProps {
  itemName: string;
  basePrice: number;
  availableCustomizations: CartCustomization[];
  onConfirm: (selected: CartCustomization[]) => void;
  onCancel: () => void;
}

export function CustomizationPicker({
  itemName,
  basePrice,
  availableCustomizations,
  onConfirm,
  onCancel,
}: CustomizationPickerProps) {
  const [selected, setSelected] = useState<CartCustomization[]>([]);

  const totalPrice =
    basePrice + selected.reduce((sum, c) => sum + c.price_delta, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onCancel]);

  function toggle(c: CartCustomization) {
    const exists = selected.find((s) => s.name === c.name);
    if (exists) {
      setSelected((prev) => prev.filter((s) => s.name !== c.name));
    } else {
      setSelected((prev) => [...prev, c]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Customize ${itemName}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-t-2xl bg-white p-6 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-primary-700">
          Customize {itemName}
        </h3>
        <p className="mt-1 text-sm text-neutral-500">
          Base price: {formatINR(basePrice)}
        </p>

        <div className="mt-4 space-y-2">
          {availableCustomizations.length === 0 && (
            <p className="text-sm text-neutral-400">
              No customizations available
            </p>
          )}
          {availableCustomizations.map((c) => {
            const isSelected = selected.some((s) => s.name === c.name);
            return (
              <button
                key={c.name}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(c)}
                className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                  isSelected
                    ? "border-primary-500 bg-primary-500/10 text-primary-700"
                    : "border-primary-500/20 text-neutral-700 hover:bg-surface-light"
                }`}
              >
                <span>{c.name}</span>
                <span className="text-xs text-neutral-500">
                  {c.price_delta > 0 ? `+${formatINR(c.price_delta)}` : "Free"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 border-t border-primary-500/20 pt-3">
          <p className="text-lg font-bold text-primary-700">
            Item total: {formatINR(totalPrice)}
          </p>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full border border-primary-500/30 py-2.5 text-sm font-medium text-primary-700 hover:bg-surface-light"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            className="flex-1 rounded-full bg-primary-500 py-2.5 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Add to Cart ({formatINR(totalPrice)})
          </button>
        </div>
      </div>
    </div>
  );
}
