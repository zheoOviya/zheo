"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import AuthGate from "@/components/AuthGate";
import { useAuthStore, useCartStore } from "@/lib/store";
import {
  fetchOrderById,
  fetchOrderHistory,
  reorderOrder,
  type OrderHistoryEntry,
  type OrderHistoryPage,
} from "@/lib/api";
import { formatINR } from "@/lib/pricing";

// Sprint 1 (I-03): Order History + Re-Order.
// Paginated past orders with a one-tap Reorder that re-places the order
// server-side (O08) and pre-fills the local cart for adjustments.

const PAGE_SIZE = 10;

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "bg-neutral-500/10 text-neutral-600" },
  PAYMENT_PENDING: {
    label: "Payment pending",
    className: "bg-amber-500/10 text-amber-700",
  },
  CONFIRMED: { label: "Confirmed", className: "bg-primary-500/10 text-primary-700" },
  READY_FOR_PICKUP: {
    label: "Ready for pickup",
    className: "bg-green-500/10 text-green-700",
  },
  PICKED_UP: { label: "Picked up", className: "bg-green-500/10 text-green-700" },
  SETTLED: { label: "Completed", className: "bg-neutral-500/10 text-neutral-600" },
  CANCELLED: { label: "Cancelled", className: "bg-red-500/10 text-red-700" },
  PAYMENT_FAILED: {
    label: "Payment failed",
    className: "bg-red-500/10 text-red-700",
  },
};

function statusBadge(status: string) {
  const meta = STATUS_STYLES[status] ?? {
    label: status.replace(/_/g, " ").toLowerCase(),
    className: "bg-neutral-500/10 text-neutral-600",
  };
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function OrderSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your orders"
      aria-busy="true"
      className="space-y-3"
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="h-4 w-1/3 animate-skeleton-teal rounded bg-primary-200" />
          <div className="mt-2 h-3 w-2/3 animate-skeleton-teal rounded bg-primary-200" />
          <div className="mt-3 h-3 w-1/4 animate-skeleton-teal rounded bg-primary-200" />
        </div>
      ))}
    </div>
  );
}

function OrderHistoryContent() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const clear = useCartStore((s) => s.clear);
  const addItem = useCartStore((s) => s.addItem);

  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<OrderHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reorderingId, setReorderingId] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchOrderHistory(accessToken, page, PAGE_SIZE)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load orders");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, page, attempt]);

  const handleReorder = useCallback(
    async (order: OrderHistoryEntry) => {
      if (!accessToken || reorderingId) return;
      setReorderingId(order.id);
      try {
        await reorderOrder(accessToken, order.id);
        // Pre-fill the local cart from the source order (I-03).
        clear();
        const source = await fetchOrderById(accessToken, order.id);
        for (const item of source.items) {
          addItem({
            menuItemId: item.menu_item_id,
            name: item.name,
            basePrice: item.base_price,
            quantity: item.quantity,
            customizations: item.customizations as never,
            restaurantId: source.restaurant_id,
            restaurantName: source.restaurant_name ?? undefined,
          });
        }
        toast.success("Order placed. Items added to your cart.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Reorder failed");
      } finally {
        setReorderingId(null);
      }
    },
    [accessToken, reorderingId, clear, addItem],
  );

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 pb-28">
      <header className="mb-6">
        <Link
          href="/"
          className="mb-4 inline-block text-sm text-primary-600 hover:text-primary-700"
        >
          &larr; Back
        </Link>
        <h1 className="text-2xl font-bold text-primary-700">Your Orders</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Past orders and quick reorder.
        </p>
      </header>

      {error && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-red-500">{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="mt-3 rounded-full border border-primary-500/30 px-5 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
          >
            Retry
          </button>
        </div>
      )}

      {loading && <OrderSkeleton />}

      {!loading && !error && history && history.orders.length === 0 && (
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm">
          <p className="text-lg font-semibold text-neutral-700">No orders yet</p>
          <p className="mt-1 text-sm text-neutral-500">
            Order ahead from a nearby restaurant to get started.
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Browse Restaurants
          </Link>
        </div>
      )}

      {!loading && !error && history && history.orders.length > 0 && (
        <div
          aria-busy={loading}
          aria-label="Order history"
          className="space-y-3"
        >
          {history.orders.map((order) => (
            <article
              key={order.id}
              className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold text-neutral-800">
                    {order.restaurant_name ?? "Restaurant"}
                  </h2>
                  {statusBadge(order.status)}
                </div>
                <p className="mt-1 text-sm text-neutral-500">
                  {order.items
                    .map((i) => `${i.name} x${i.quantity}`)
                    .join(", ")}
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  {formatDate(order.created_at)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end">
                <p className="text-base font-bold text-primary-700">
                  {formatINR(order.total_amount)}
                </p>
                <button
                  type="button"
                  onClick={() => handleReorder(order)}
                  disabled={reorderingId === order.id}
                  aria-busy={reorderingId === order.id}
                  className="shrink-0 rounded-full bg-primary-500 px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reorderingId === order.id ? "Reordering..." : "Reorder"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && !error && history && history.pages > 1 && (
        <nav
          aria-label="Order history pages"
          className="mt-6 flex items-center justify-center gap-4"
        >
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-semibold text-primary-700 hover:bg-surface-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            &larr; Previous
          </button>
          <span className="text-sm text-neutral-500">
            Page {page} of {history.pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(history.pages, p + 1))}
            disabled={page >= history.pages}
            className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-semibold text-primary-700 hover:bg-surface-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next &rarr;
          </button>
        </nav>
      )}
    </main>
  );
}

export default function OrderHistoryPage() {
  return (
    <AuthGate>
      <OrderHistoryContent />
    </AuthGate>
  );
}
