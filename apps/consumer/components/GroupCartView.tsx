"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  addToGroupCart,
  fetchGroupCart,
  type GroupCartSnapshot,
} from "@/lib/api";
import { useAuthStore, useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/pricing";

// Live Group Cart (O02): polls the share-token snapshot every 2s and renders
// the contributors as colored avatar circles (masked identity, never raw
// phone numbers) with their item lines. Any signed-in viewer can tap
// "Add my cart items" to merge their picks into the single DRAFT order.

const AVATAR_COLORS = [
  "bg-teal-600",
  "bg-cyan-600",
  "bg-emerald-600",
  "bg-indigo-500",
  "bg-rose-500",
  "bg-amber-500",
];

function avatarClass(seed: string): string {
  const n = seed.replace(/\D/g, "");
  const idx = n.length > 0 ? Number(n) % AVATAR_COLORS.length : 0;
  return AVATAR_COLORS[idx] ?? AVATAR_COLORS[0]!;
}

function avatarLabel(seed: string): string {
  const digits = seed.replace(/\D/g, "");
  return digits.length > 0 ? digits.slice(-2) : "??";
}

export function GroupCartView({ token }: { token: string }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const { items, restaurantId, clear } = useCartStore();
  const [snapshot, setSnapshot] = useState<GroupCartSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const snap = await fetchGroupCart(token);
      setSnapshot(snap);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load group cart");
    }
  }, [token]);

  // Live view: fetch immediately, then poll every 2s so concurrent
  // contributors' additions appear without a manual refresh.
  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 2000);
    return () => clearInterval(interval);
  }, [load]);

  const shareLink =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/group-cart?token=${encodeURIComponent(token)}`;

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  async function handleAddMyItems() {
    if (!accessToken || items.length === 0 || !snapshot) return;
    setAdding(true);
    setError(null);
    try {
      await addToGroupCart(
        accessToken,
        snapshot.group_cart_token,
        items.map((i) => ({
          menu_item_id: i.menuItemId,
          quantity: i.quantity,
          customizations: i.customizations,
        })),
      );
      clear();
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add your items",
      );
    } finally {
      setAdding(false);
    }
  }

  if (error && !snapshot) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 rounded-full bg-primary-500 px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {snapshot && (
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-primary-700">
                Live Group Cart
              </h2>
              <p className="mt-1 text-xs text-neutral-400">
                {snapshot.status === "DRAFT"
                  ? "Open - anyone with the link can add items"
                  : `Closed - order status: ${snapshot.status}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyLink}
                className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
              >
                {copied ? "Copied!" : "Copy Invite Link"}
              </button>
              <Link
                href={`/restaurants/${snapshot.restaurant_id}`}
                className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
              >
                View Menu
              </Link>
            </div>
          </div>

          <hr className="my-4 border-primary-500/20" />

          {/* Contributors: one teal avatar circle per person (masked identity). */}
          <h3 className="mb-3 text-sm font-semibold text-neutral-600">
            Contributors ({snapshot.contributors.length})
          </h3>
          <ul className="flex flex-wrap gap-4">
            {snapshot.contributors.map((c) => (
              <li key={c.user_id} className="flex items-center gap-2">
                <span
                  title={c.display_name}
                  className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white ${avatarClass(c.avatar_seed)}`}
                >
                  {avatarLabel(c.avatar_seed)}
                </span>
                <span className="text-xs font-medium text-neutral-600">
                  {c.display_name}
                </span>
              </li>
            ))}
          </ul>

          {/* Item lines: every contribution persists as its own line. */}
          {snapshot.items.length > 0 ? (
            <ul className="mt-4 divide-y divide-primary-500/10">
              {snapshot.items.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span className="text-neutral-700">
                    {line.name}{" "}
                    <span className="text-neutral-400">x{line.quantity}</span>
                  </span>
                  <span className="font-medium text-neutral-600">
                    {formatINR(line.item_subtotal)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-neutral-400">
              No items yet. Share the invite link to start collecting picks.
            </p>
          )}

          <hr className="my-4 border-primary-500/20" />

          <div className="flex items-center justify-between text-base font-bold text-primary-700">
            <span>
              {snapshot.item_count} item{snapshot.item_count === 1 ? "" : "s"}
            </span>
            <span>{formatINR(snapshot.total_amount)}</span>
          </div>
        </div>
      )}

      {/* Add-your-cart seam: lets the current signed-in viewer merge their
          local cart items into the shared order. */}
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-neutral-600">
          Your picks ({items.reduce((sum, i) => sum + i.quantity, 0)} in cart)
        </h3>
        {items.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-400">
            {restaurantId
              ? "Your cart is empty."
              : "Browse the restaurant and add items to your cart first."}
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-2">
              {items.map((i) => (
                <li
                  key={i.menuItemId}
                  className="flex justify-between text-sm text-neutral-600"
                >
                  <span>
                    {i.name} x{i.quantity}
                  </span>
                  <span className="font-medium">
                    {formatINR(
                      (i.basePrice +
                        i.customizations.reduce((s, c) => s + c.price_delta, 0)) *
                        i.quantity,
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {!accessToken ? (
              <Link
                href="/login"
                className="mt-4 block w-full rounded-full bg-primary-500 py-3 text-center text-sm font-semibold text-white hover:bg-primary-hover"
              >
                Sign in to add your items
              </Link>
            ) : (
              <button
                type="button"
                disabled={adding || snapshot?.status !== "DRAFT"}
                onClick={handleAddMyItems}
                className="mt-4 w-full rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {adding
                  ? "Adding..."
                  : snapshot?.status !== "DRAFT"
                    ? "Group order closed"
                    : "Add My Items to Group Order"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
