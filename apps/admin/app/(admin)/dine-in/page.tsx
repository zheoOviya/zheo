"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fetchAdminDineInOverview,
  fetchAdminDineInSessions,
  type AdminDineInLiveSessionStatus,
  type AdminDineInBillStatus,
  type AdminDineInOverview,
  type AdminDineInSessionList,
} from "../../../lib/api";

const SESSION_STATUS_LABELS: Record<AdminDineInLiveSessionStatus, string> = {
  OPEN: "Open",
  ACTIVE: "Active",
  BILL_REQUESTED: "Bill requested",
  PAYMENT_PENDING: "Payment pending",
};

const SESSION_STATUS_COLORS: Record<AdminDineInLiveSessionStatus, string> = {
  OPEN: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  BILL_REQUESTED: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  PAYMENT_PENDING: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
};

const BILL_STATUS_COLORS: Record<AdminDineInBillStatus, string> = {
  NONE: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  REQUESTED: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ACKNOWLEDGED: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  DELIVERED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const BILL_STATUS_LABELS: Record<AdminDineInBillStatus, string> = {
  NONE: "None",
  REQUESTED: "Requested",
  ACKNOWLEDGED: "Acknowledged",
  DELIVERED: "Delivered",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString();

export default function DineInOverviewPage() {
  const [overview, setOverview] = useState<AdminDineInOverview | null>(null);
  const [list, setList] = useState<AdminDineInSessionList | null>(null);
  const [restaurantId, setRestaurantId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(() => {
    setErrors([]);
    const params = {
      page,
      limit: 20,
      restaurant_id: restaurantId || undefined,
      status: (status || undefined) as AdminDineInLiveSessionStatus | undefined,
    };
    fetchAdminDineInOverview()
      .then(setOverview)
      .catch((e) =>
        setErrors((prev) => [...prev, e instanceof Error ? e.message : "Failed to load dine-in overview"]),
      );
    fetchAdminDineInSessions(params)
      .then(setList)
      .catch((e) =>
        setErrors((prev) => [...prev, e instanceof Error ? e.message : "Failed to load dine-in sessions"]),
      );
  }, [page, restaurantId, status]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const restaurants = useMemo(() => {
    const byId = new Map<string, string>();
    overview?.by_restaurant.forEach((r) => byId.set(r.restaurant_id, r.restaurant_name));
    list?.items.forEach((r) => {
      if (!byId.has(r.restaurant_id)) byId.set(r.restaurant_id, r.restaurant_name);
    });
    if (restaurantId && !byId.has(restaurantId)) {
      const row = list?.items.find((r) => r.restaurant_id === restaurantId);
      if (row) byId.set(restaurantId, row.restaurant_name);
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [overview, list, restaurantId]);

  const totalPages = list ? Math.max(1, Math.ceil(list.pagination.total / list.pagination.limit)) : 1;
  const loading = !overview && !list && errors.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Dine-In Oversight</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Refreshes automatically every 60s.</p>
        </div>
        <button
          onClick={load}
          className="rounded-lg bg-primary-500 hover:bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors"
        >
          Refresh
        </button>
      </div>

      {errors.length > 0 && (
        <div className="space-y-2">
          {errors.map((err) => (
            <div key={err} className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
              {err}
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
            ))}
          </div>
          <div className="h-64 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        </div>
      )}

      {!loading && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Active sessions</p>
              <p className="mt-1 text-2xl font-bold text-primary-600 dark:text-primary-400">
                {overview?.totals.active_sessions ?? "—"}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Bill requested</p>
              <p className="mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400">
                {overview?.totals.bill_requested_sessions ?? "—"}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Pending service requests</p>
              <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {overview?.totals.pending_service_requests ?? "—"}
              </p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Restaurants</p>
              <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {overview?.totals.restaurants ?? "—"}
              </p>
            </div>
          </div>

          {(overview?.by_restaurant.length ?? 0) > 0 && (
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">By restaurant</p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-neutral-200 dark:border-neutral-800">
                    <tr>
                      <th className="py-2 pr-3 text-neutral-500">Restaurant</th>
                      <th className="py-2 pr-3 text-neutral-500">Active</th>
                      <th className="py-2 pr-3 text-neutral-500">Bill requested</th>
                      <th className="py-2 pr-3 text-neutral-500">Pending requests</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {overview?.by_restaurant.map((r) => (
                      <tr key={r.restaurant_id} className="text-neutral-700 dark:text-neutral-300">
                        <td className="py-2 pr-3 font-medium">{r.restaurant_name}</td>
                        <td className="py-2 pr-3 tabular-nums">{r.active_sessions}</td>
                        <td className="py-2 pr-3 tabular-nums">{r.bill_requested_sessions}</td>
                        <td className="py-2 pr-3 tabular-nums">{r.pending_service_requests}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filter by restaurant"
              value={restaurantId}
              onChange={(e) => {
                setRestaurantId(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
            >
              <option value="">All restaurants</option>
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <select
              aria-label="Filter by session status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
            >
              <option value="">All session statuses</option>
              {Object.entries(SESSION_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                <tr>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Restaurant</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Table</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Zone</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Session status</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Orders</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Pending requests</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Bill</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Opened</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {list?.items.map((row) => (
                  <tr key={row.session_id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-neutral-800 dark:text-neutral-200">{row.restaurant_name}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dine-in/sessions/${row.session_id}`}
                        className="font-mono text-xs text-primary-600 dark:text-primary-400 hover:text-primary-500 hover:underline"
                        title="Open session detail"
                      >
                        {row.table_label}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">{row.zone_name ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${SESSION_STATUS_COLORS[row.status]}`}>
                        {SESSION_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-neutral-700 dark:text-neutral-300">{row.order_count}</td>
                    <td className="px-4 py-3 tabular-nums text-neutral-700 dark:text-neutral-300">{row.pending_service_request_count}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${BILL_STATUS_COLORS[row.bill_status]}`}>
                        {BILL_STATUS_LABELS[row.bill_status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500 whitespace-nowrap">{fmtTime(row.opened_at)}</td>
                    <td className="px-4 py-3 text-xs text-neutral-500 whitespace-nowrap">{fmtTime(row.updated_at)}</td>
                  </tr>
                ))}
                {list && list.items.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-sm text-neutral-400">
                      No live dine-in sessions
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {list && totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">
                Page {list.pagination.page} of {totalPages} ({list.pagination.total} sessions)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={list.pagination.page <= 1}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={list.pagination.page >= totalPages}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
