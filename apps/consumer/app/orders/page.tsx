"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import AuthGate from "@/components/AuthGate";
import { useAuthStore, useCartStore } from "@/lib/store";
import { fetchOrderById, fetchOrderHistory, reorderOrder, type OrderHistoryEntry } from "@/lib/api";
import { formatINR } from "@/lib/pricing";

// Sprint 1 (I-03): Order History + Re-Order.
// Cursor-paginated past orders with a one-tap Reorder that re-places the order
// server-side (O08) and pre-fills the local cart for adjustments.
// Active/in-progress orders are pinned above completed ones (Baymard: order
// tracking is the most-used self-service feature, so it must not be buried).

const PAGE_SIZE = 10;

const TERMINAL_STATUSES = new Set([
  "PICKED_UP",
  "SETTLED",
  "CANCELLED",
  "REFUNDED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "DISPUTED",
]);

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  DRAFT: { label: "Draft", className: "bg-neutral-500/10 text-neutral-600" },
  PAYMENT_PENDING: {
    label: "Payment pending",
    className: "bg-amber-500/10 text-amber-700",
  },
  CONFIRMED: { label: "Confirmed", className: "bg-primary-500/10 text-primary-700" },
  PREPARING: { label: "Preparing", className: "bg-primary-500/10 text-primary-700" },
  ALMOST_READY: { label: "Almost ready", className: "bg-primary-500/10 text-primary-700" },
  READY_FOR_PICKUP: {
    label: "Ready for pickup",
    className: "bg-green-500/10 text-green-700",
  },
  PICKED_UP: { label: "Picked up", className: "bg-green-500/10 text-green-700" },
  SETTLED: { label: "Completed", className: "bg-neutral-500/10 text-neutral-600" },
  CANCELLED: { label: "Cancelled", className: "bg-red-500/10 text-red-700" },
  REFUNDED: { label: "Refunded", className: "bg-neutral-500/10 text-neutral-600" },
  PAYMENT_FAILED: {
    label: "Payment failed",
    className: "bg-red-500/10 text-red-700",
  },
  EXPIRED: { label: "Expired", className: "bg-neutral-500/10 text-neutral-600" },
  DISPUTED: { label: "Disputed", className: "bg-red-500/10 text-red-700" },
};

function statusBadge(status: string) {
  const meta = STATUS_STYLES[status] ?? {
    label: status.replace(/_/g, " ").toLowerCase(),
    className: "bg-neutral-500/10 text-neutral-600",
  };
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function OrderSkeleton() {
  return (
    <div role="status" aria-label="Loading your orders" aria-busy="true" className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-white p-4 shadow-sm dark:bg-neutral-900">
          <div className="h-4 w-1/3 animate-skeleton-teal rounded bg-primary-200 dark:bg-primary-900/30" />
          <div className="mt-2 h-3 w-2/3 animate-skeleton-teal rounded bg-primary-200 dark:bg-primary-900/30" />
          <div className="mt-3 h-3 w-1/4 animate-skeleton-teal rounded bg-primary-200 dark:bg-primary-900/30" />
        </div>
      ))}
    </div>
  );
}

type HistoryFilter = "active" | "past" | "all";

const FILTERS: { key: HistoryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "past", label: "Past" },
];

function OrderHistoryContent() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const clear = useCartStore((s) => s.clear);
  const addItem = useCartStore((s) => s.addItem);

  const [orders, setOrders] = useState<OrderHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reorderingId, setReorderingId] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchOrderHistory(accessToken, undefined, PAGE_SIZE)
      .then((data) => {
        if (cancelled) return;
        setOrders(data.orders);
        setNextCursor(data.next_cursor);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load orders");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, filter, attempt]);

  const loadMore = useCallback(async () => {
    if (!accessToken || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchOrderHistory(accessToken, nextCursor, PAGE_SIZE);
      setOrders((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...data.orders.filter((o) => !seen.has(o.id))];
      });
      setNextCursor(data.next_cursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load more orders");
    } finally {
      setLoadingMore(false);
    }
  }, [accessToken, nextCursor, loadingMore]);

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

  const isActive = (o: OrderHistoryEntry) => !TERMINAL_STATUSES.has(o.status);
  const visibleOrders = orders.filter((o) => {
    if (filter === "active") return isActive(o);
    if (filter === "past") return !isActive(o);
    return true;
  });
  const activeOrders = visibleOrders.filter(isActive);
  const pastOrders = visibleOrders.filter((o) => !isActive(o));

  function renderOrderCard(order: OrderHistoryEntry) {
    const active = isActive(order);
    const info = (
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-semibold text-neutral-800 dark:text-neutral-100">
            {order.restaurant_name ?? "Restaurant"}
          </h2>
          {statusBadge(order.status)}
        </div>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
        </p>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          {formatDate(order.created_at)}
          {order.scheduled_pickup_time
            ? ` · pickup ${new Date(order.scheduled_pickup_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""}
        </p>
      </div>
    );

    return (
      <article
        className={`rounded-2xl bg-white p-4 shadow-sm sm:flex-row sm:items-center dark:bg-neutral-900 ${
          active ? "ring-1 ring-primary-500/20" : ""
        }`}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {active ? (
            <Link href={`/orders/${order.id}`} className="flex min-w-0 flex-1">
              {info}
            </Link>
          ) : (
            info
          )}
          <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end">
            <p className="text-base font-bold text-primary-700 dark:text-primary-400">
              {formatINR(order.total_amount)}
            </p>
            <div className="flex items-center gap-2">
              {active && (
                <Link
                  href={`/orders/${order.id}`}
                  className="rounded-full bg-primary-500/10 px-4 py-2 text-sm font-semibold text-primary-700 hover:bg-primary-500/20 dark:text-primary-400"
                >
                  Track →
                </Link>
              )}
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
          </div>
        </div>
      </article>
    );
  }

  return (
    <main className="py-6 pb-28">
      <header className="mb-6">
        <Link
          href="/"
          className="mb-4 inline-block text-sm text-primary-600 hover:text-primary-700"
        >
          &larr; Back
        </Link>
        <h1 className="text-2xl font-bold text-primary-700 dark:text-primary-300">Your Orders</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Track in-progress orders and reorder past ones.
        </p>
      </header>

      {error && (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm dark:bg-neutral-900">
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

      <div className="mb-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              filter === f.key
                ? "bg-primary text-white"
                : "bg-white text-neutral-500 shadow-sm hover:bg-surface-light dark:bg-neutral-900 dark:text-neutral-400"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <OrderSkeleton />}

      {!loading && !error && orders.length === 0 && (
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm dark:bg-neutral-900">
          <p className="text-lg font-semibold text-neutral-700 dark:text-neutral-200">
            No orders yet
          </p>
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

      {!loading && !error && orders.length > 0 && (
        <div className="space-y-3" aria-busy={loading} aria-label="Order history">
          {activeOrders.length > 0 && (
            <section aria-label="Active orders">
              <h2 className="mb-2 text-xs font-bold tracking-wider text-neutral-400 uppercase">
                In progress
              </h2>
              <div className="space-y-3">{activeOrders.map(renderOrderCard)}</div>
            </section>
          )}
          {pastOrders.length > 0 && (
            <section aria-label="Past orders" className="pt-2">
              <h2 className="mb-2 text-xs font-bold tracking-wider text-neutral-400 uppercase">
                Past orders
              </h2>
              <div className="space-y-3">{pastOrders.map(renderOrderCard)}</div>
            </section>
          )}
        </div>
      )}

      {!loading && !error && nextCursor && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-full border border-primary-500/30 px-6 py-2 text-sm font-semibold text-primary-700 hover:bg-surface-light disabled:cursor-not-allowed disabled:opacity-50 dark:text-primary-400"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
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
