"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { XMarkIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { BrandImage } from "@/components/BrandImage";
import { useAuthStore, useCartStore } from "@/lib/store";
import { createGroupCart } from "@/lib/api";
import { computePriceBreakdown, formatINR, itemUnitPrice } from "@/lib/pricing";
import { PriceBreakdown, type BreakdownItem } from "./PriceBreakdown";
import { EmptyState } from "@snakzap/ui";
import toast from "react-hot-toast";

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const els = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  return els;
}

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { items, restaurantId, removeItem, updateQuantity, clear, hydrateFromServer } =
    useCartStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [startingGroup, setStartingGroup] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [animating, setAnimating] = useState(false);
  const breakdown = computePriceBreakdown(items);
  const hydratedRef = useRef(false);
  const expiryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCartExpiry = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await fetch("/api/v1/cart", {
        headers: { Authorization: `Bearer ${accessToken}` },
        credentials: "include",
      });
      if (!res.ok) return;
      const body = await res.json();
      if (body.data?.expires_at) {
        setExpiresAt(body.data.expires_at);
      }
    } catch {
      // offline / unreachable - countdown is cosmetic
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken || hydratedRef.current) return;
    hydratedRef.current = true;
    void hydrateFromServer(accessToken);
    void fetchCartExpiry();
  }, [accessToken, hydrateFromServer, fetchCartExpiry]);

  useEffect(() => {
    if (expiryTimerRef.current) {
      clearInterval(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    if (!expiresAt) {
      setTimeLeft(null);
      return;
    }

    const tick = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("Expired");
        clear();
        onClose();
        toast("Your cart has expired. Items have been removed.", {
          duration: 5000,
          style: { background: "#991b1b", color: "#fecaca" },
        });
        if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
        return;
      }
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      setTimeLeft(`${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`);
    };

    tick();
    expiryTimerRef.current = setInterval(tick, 30000);
    return () => {
      if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    };
  }, [expiresAt, clear, onClose]);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    setTimeout(() => {
      if (dialogRef.current) {
        const focusable = getFocusableElements(dialogRef.current);
        const firstEl = focusable[0];
        if (firstEl) firstEl.focus();
      }
    }, 50);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      triggerRef.current?.focus();
      triggerRef.current = null;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setAnimating(true));
      return () => cancelAnimationFrame(raf);
    }
    setAnimating(false);
    const timer = setTimeout(() => setMounted(false), 250);
    return () => clearTimeout(timer);
  }, [open]);

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
      setGroupError(err instanceof Error ? err.message : "Could not start a group order");
      setStartingGroup(false);
    }
  }

  function getExpiryColor(): string {
    if (!expiresAt) return "";
    const diff = new Date(expiresAt).getTime() - Date.now();
    const diffMin = diff / 60000;
    if (diffMin < 10) return "text-red-500 animate-pulse";
    if (diffMin < 60) return "text-amber-500";
    return "text-teal-600";
  }

  if (!mounted) return null;

  const itemBreakdowns: BreakdownItem[] = items.map((item) => ({
    label: `${item.name} x${item.quantity}`,
    amount: itemUnitPrice(item) * item.quantity,
  }));

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
      <div
        aria-hidden="true"
        className={[
          "absolute inset-0 bg-black/40 transition-opacity duration-250 ease-brand",
          animating ? "opacity-100" : "opacity-0",
        ].join(" ")}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Your cart"
        onClick={(e) => e.stopPropagation()}
        className={[
          "flex max-h-[85vh] w-full max-w-md flex-col overflow-auto rounded-t-3xl bg-white shadow-elevation-3 dark:bg-neutral-900",
          "transition-transform duration-250 ease-brand",
          animating ? "translate-y-0" : "translate-y-full",
        ].join(" ")}
      >
        <div className="sticky top-0 z-10 border-b border-neutral-100 bg-white/95 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/95">
          <div
            className="mx-auto mt-2 h-1 w-10 rounded-full bg-neutral-200 dark:bg-neutral-700"
            aria-hidden="true"
          />
          <div className="flex items-center justify-between px-5 pb-3 pt-2">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-neutral-900 dark:text-white">
                Your Cart{" "}
                <span className="text-sm font-semibold text-neutral-400 dark:text-neutral-500">
                  ({breakdown.itemCount})
                </span>
              </h2>
              {timeLeft && (
                <p aria-live="polite" className={`text-xs font-medium ${getExpiryColor()}`}>
                  Expires in {timeLeft}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close cart"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={
              <ShoppingBagIcon className="h-10 w-10 text-primary-500" />
            }
            title="Your cart is empty"
            description="Add items from a restaurant to get started."
            cta={
              <button
                type="button"
                onClick={() => {
                  onClose();
                  router.push("/");
                }}
                className="btn-primary"
              >
                Browse Restaurants
              </button>
            }
          />
        ) : (
          <div className="space-y-3 p-5">
            {items.map((item) => (
              <div key={item.menuItemId} className="surface-card flex items-center gap-3 p-3">
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-primary-100 dark:bg-primary-900/30">
                  <BrandImage alt="" sizes="56px" className="object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    {item.name}
                  </p>
                  {item.customizations.length > 0 && (
                    <p className="line-clamp-1 text-xs text-neutral-400">
                      {item.customizations.map((c) => c.name).join(", ")}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs font-semibold text-primary-600 dark:text-primary-400">
                    {formatINR(itemUnitPrice(item))} each
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    onClick={() => updateQuantity(item.menuItemId, item.quantity - 1)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-100 text-base font-bold text-neutral-600 transition-colors hover:bg-primary-500/15 hover:text-primary-700 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    -
                  </button>
                  <span className="w-6 text-center text-sm font-bold text-neutral-800 dark:text-neutral-100">
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    onClick={() => updateQuantity(item.menuItemId, item.quantity + 1)}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-500 text-base font-bold text-white transition-colors hover:bg-primary-hover"
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeItem(item.menuItemId)}
                  className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-red-500"
                >
                  Remove
                </button>
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
              className="min-h-[44px] w-full rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm shadow-primary-700/20 transition-transform hover:from-primary-800 hover:to-primary-600 active:scale-[0.99] disabled:opacity-50"
            >
              Place Order ({formatINR(breakdown.total)})
            </button>

            <button
              type="button"
              disabled={items.length === 0 || startingGroup}
              onClick={handleStartGroupOrder}
              className="btn-outline min-h-[44px] w-full rounded-2xl"
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
            <div className="pb-safe" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}
