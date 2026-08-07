"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [startingGroup, setStartingGroup] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
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

  function getExpiryColor(): string {
    if (!expiresAt) return "";
    const diff = new Date(expiresAt).getTime() - Date.now();
    const diffMin = diff / 60000;
    if (diffMin < 10) return "text-red-500 animate-pulse";
    if (diffMin < 60) return "text-amber-500";
    return "text-teal-600";
  }

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Your cart"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-auto rounded-t-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-primary-500/20 p-4">
          <div>
            <h2 className="text-lg font-semibold text-primary-700">
              Your Cart ({breakdown.itemCount})
            </h2>
            {timeLeft && (
              <p
                aria-live="polite"
                className={`text-xs font-medium ${getExpiryColor()}`}
              >
                Expires in {timeLeft}
              </p>
            )}
          </div>
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
          <EmptyState
            icon={
              <svg
                aria-hidden="true"
                className="h-10 w-10 text-primary-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                />
              </svg>
            }
            title="Your cart is empty"
            description="Add items from a restaurant to get started."
            cta={
              <button
                type="button"
                onClick={() => { onClose(); router.push("/"); }}
                className="rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                Browse Restaurants
              </button>
            }
          />
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
