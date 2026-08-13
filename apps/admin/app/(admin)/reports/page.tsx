"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchDashboardMetrics,
  fetchHeatmap,
  fetchLiveOrders,
  type DashboardMetrics,
  type HeatmapResult,
} from "../../../lib/api";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

const STATUS_COLORS: Record<string, string> = {
  PLACED: "bg-neutral-400",
  CONFIRMED: "bg-sky-400",
  PREPARING: "bg-amber-400",
  ALMOST_READY: "bg-violet-400",
  READY_FOR_PICKUP: "bg-primary-400",
  PICKED_UP: "bg-emerald-400",
  SETTLED: "bg-emerald-600",
  CANCELLED: "bg-red-400",
};

export default function ReportsPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [orders, setOrders] = useState<{ orders: { status: string }[]; statusCounts: Record<string, number> } | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([fetchDashboardMetrics(), fetchLiveOrders(), fetchHeatmap()])
      .then(([m, o, h]) => {
        setMetrics(m);
        setOrders(o);
        setHeatmap(h);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load reports"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) {
    return <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />;
  }

  const statusEntries = Object.entries(orders?.statusCounts ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  const totalCount = statusEntries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          Reports
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Revenue, order mix, and demand snapshot. Auto-refreshes every 60s.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Daily Revenue</p>
          <p className="mt-1 text-2xl font-bold text-primary-600 dark:text-primary-400">
            {metrics ? fmt(metrics.daily_revenue) : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Orders Today</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {metrics?.total_orders_today ?? "-"}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Avg Pickup Time</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {metrics ? `${metrics.avg_pickup_time_min} min` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">CAC / LTV</p>
          <p className={`mt-1 text-2xl font-bold ${metrics && metrics.cac_ltv_ratio > 1 ? "text-red-500" : "text-emerald-500"}`}>
            {metrics ? metrics.cac_ltv_ratio.toFixed(2) : "-"}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-neutral-800 dark:text-neutral-200">
              Order Status Mix
            </p>
            <span className="text-xs text-neutral-400">{totalCount} live orders</span>
          </div>
          <div className="mt-4 space-y-3">
            {statusEntries.map(([status, count]) => {
              const pct = totalCount > 0 ? Math.round((count / totalCount) * 100) : 0;
              return (
                <div key={status}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-neutral-600 dark:text-neutral-300">{status}</span>
                    <span className="text-neutral-400">{count}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-neutral-100 dark:bg-neutral-800">
                    <div
                      className={`h-2 rounded-full ${STATUS_COLORS[status] ?? "bg-neutral-400"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {statusEntries.length === 0 && (
              <p className="py-6 text-center text-sm text-neutral-400">No orders yet.</p>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-neutral-800 dark:text-neutral-200">
              Demand Snapshot
            </p>
            <span className="text-xs text-neutral-400">
              {heatmap ? `${heatmap.window_minutes} min window` : "heatmap"}
            </span>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Orders in window</dt>
              <dd className="font-semibold text-neutral-800 dark:text-neutral-200">
                {heatmap?.total_orders ?? "-"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Active demand zones</dt>
              <dd className="font-semibold text-neutral-800 dark:text-neutral-200">
                {heatmap ? heatmap.cells.length : "-"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Generated at</dt>
              <dd className="font-semibold text-neutral-800 dark:text-neutral-200">
                {heatmap ? new Date(heatmap.generated_at).toLocaleTimeString() : "-"}
              </dd>
            </div>
          </dl>
          <Link
            href="/heatmap"
            className="mt-4 inline-flex rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            Open full heatmap
          </Link>
        </div>
      </div>
    </div>
  );
}
