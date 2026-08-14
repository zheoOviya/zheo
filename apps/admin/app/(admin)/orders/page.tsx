"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { fetchLiveOrders, fetchOrderDetail, overrideOrderStatus, type OrderDetailDTO } from "../../../lib/api";

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "Confirmed",
  PREPARING: "Preparing",
  ALMOST_READY: "Almost Ready",
  READY_FOR_PICKUP: "Ready",
};

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  PREPARING: "bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400",
  ALMOST_READY: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  READY_FOR_PICKUP: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  CREATED: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  AUTHORIZED: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  CAPTURED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  REFUNDED: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

export default function OrdersPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchLiveOrders>> | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetailDTO | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [overrideStatus, setOverrideStatusState] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [overriding, setOverriding] = useState(false);

  const load = useCallback(() => {
    setError("");
    fetchLiveOrders(statusFilter || undefined)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [statusFilter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function showDetail(orderId: string) {
    if (expandedId === orderId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(orderId);
    setLoadingDetail(true);
    try {
      const d = await fetchOrderDetail(orderId);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order detail");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleOverride(orderId: string) {
    if (!overrideStatus) return;
    setOverriding(true);
    try {
      await overrideOrderStatus(orderId, overrideStatus, overrideReason || undefined);
      setOverrideStatusState("");
      setOverrideReason("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Override failed");
    } finally {
      setOverriding(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Live Orders</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">Auto-refresh 30s</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setStatusFilter("")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            !statusFilter
              ? "bg-primary-500 text-white"
              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          }`}
        >
          All ({data?.total ?? 0})
        </button>
        {Object.entries(STATUS_LABELS).map(([s, label]) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              statusFilter === s
                ? "bg-primary-500 text-white"
                : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            }`}
          >
            {label} ({data?.statusCounts?.[s] ?? 0})
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      )}

      {data && (
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
              <tr>
                <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Order ID</th>
                <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Status</th>
                <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Amount</th>
                <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Created</th>
                <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {data.orders.map((o) => (
                <Fragment key={o.id}>
                  <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">{o.id.slice(0, 12)}...</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[o.status] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
                        {o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm tabular-nums">Rs.{Number(o.total_amount).toFixed(0)}</td>
                    <td className="px-4 py-3 text-xs text-neutral-500">{new Date(o.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => showDetail(o.id)}
                        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                      >
                        {expandedId === o.id ? "Hide" : "Detail"}
                      </button>
                    </td>
                  </tr>
                  {expandedId === o.id && (
                    <tr key={`${o.id}-detail`}>
                      <td colSpan={5} className="px-4 py-3 bg-neutral-50 dark:bg-neutral-950">
                        {loadingDetail ? (
                          <div className="h-12 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
                        ) : detail ? (
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                              <div>
                                <span className="text-neutral-500">Customer:</span>
                                <p className="font-mono text-neutral-700 dark:text-neutral-300">
                                  {detail.customer ? (
                                    <Link href={`/users/${detail.customer.id}`} className="hover:text-primary-500 hover:underline">
                                      {detail.customer.phone}
                                    </Link>
                                  ) : detail.user_id.slice(0, 16)}
                                </p>
                              </div>
                              <div>
                                <span className="text-neutral-500">Restaurant:</span>
                                <p className="font-mono text-neutral-700 dark:text-neutral-300">{detail.restaurant?.name ?? detail.restaurant_id.slice(0, 16)}</p>
                              </div>
                              <div>
                                <span className="text-neutral-500">Total / Commission:</span>
                                <p className="font-mono text-neutral-700 dark:text-neutral-300">
                                  Rs.{Number(detail.total_amount).toFixed(0)} / Rs.{Number(detail.commission_amount ?? 0).toFixed(0)}
                                </p>
                              </div>
                              <div>
                                <span className="text-neutral-500">Created:</span>
                                <p className="text-neutral-700 dark:text-neutral-300">{new Date(detail.created_at).toLocaleString()}</p>
                              </div>
                            </div>

                            {detail.items && detail.items.length > 0 && (
                              <div>
                                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Items</p>
                                <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
                                  <table className="w-full text-left text-xs">
                                    <thead className="bg-neutral-50 dark:bg-neutral-950">
                                      <tr>
                                        <th className="px-3 py-2 text-neutral-500">Item</th>
                                        <th className="px-3 py-2 text-neutral-500">Qty</th>
                                        <th className="px-3 py-2 text-neutral-500">Price</th>
                                        <th className="px-3 py-2 text-neutral-500">Customizations</th>
                                        <th className="px-3 py-2 text-neutral-500">Subtotal</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                                      {detail.items.map((it) => (
                                        <tr key={it.id}>
                                          <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{it.name}</td>
                                          <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{it.quantity}</td>
                                          <td className="px-3 py-2 font-mono tabular-nums text-neutral-700 dark:text-neutral-300">Rs.{it.base_price.toFixed(0)}</td>
                                          <td className="px-3 py-2 text-neutral-500">
                                            {it.customization_total > 0 ? `+Rs.${it.customization_total.toFixed(0)}` : "—"}
                                          </td>
                                          <td className="px-3 py-2 font-mono tabular-nums text-neutral-700 dark:text-neutral-300">Rs.{it.item_subtotal.toFixed(0)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {detail.payment && (
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="text-neutral-500">Payment:</span>
                                <span className={`inline-block rounded-full px-2 py-0.5 font-semibold ${PAYMENT_STATUS_COLORS[detail.payment.status] ?? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
                                  {detail.payment.status}
                                </span>
                                <span className="text-neutral-700 dark:text-neutral-300">{(detail.payment.method ?? "N/A").toUpperCase()}</span>
                                <span className="text-neutral-500">Rs.{Number(detail.payment.amount).toFixed(0)}</span>
                              </div>
                            )}

                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-neutral-500">Override Status:</span>
                              <select
                                value={overrideStatus}
                                onChange={(e) => setOverrideStatusState(e.target.value)}
                                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 outline-none"
                              >
                                <option value="">-- select --</option>
                                {["CONFIRMED", "PREPARING", "ALMOST_READY", "READY_FOR_PICKUP", "PICKED_UP", "SETTLED", "CANCELLED"].map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                              <input
                                type="text"
                                placeholder="Reason..."
                                value={overrideReason}
                                onChange={(e) => setOverrideReason(e.target.value)}
                                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 outline-none"
                              />
                              <button
                                onClick={() => handleOverride(o.id)}
                                disabled={!overrideStatus || overriding}
                                className="rounded-lg bg-accent-500 hover:bg-accent-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors disabled:opacity-50"
                              >
                                {overriding ? "..." : "Override"}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-neutral-400">Failed to load details</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {data.orders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-400">
                    No live orders
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
