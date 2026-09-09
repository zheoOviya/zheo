"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchDashboardMetrics, type DashboardMetrics } from "../../../lib/api";
import { getTotpStatus } from "../../../lib/totp";
import Link from "next/link";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState("");
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);

  const load = useCallback(() => {
    fetchDashboardMetrics()
      .then(setMetrics)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    getTotpStatus()
      .then((s) => setTotpEnabled(s.totp_enabled))
      .catch(() => setTotpEnabled(null));
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-6 text-red-600 dark:text-red-400">
        Failed to load dashboard: {error}
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800"
          />
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "Today's Revenue",
      value: fmt(metrics.revenue_today),
      sub: "Gross incl. GST · orders placed today",
      color: "text-primary-600 dark:text-primary-400",
    },
    {
      label: "Fulfilled Orders Today",
      value: metrics.fulfilled_orders_today.toString(),
      sub: "PICKED_UP / SETTLED · placed today",
      color: "text-neutral-900 dark:text-neutral-100",
    },
    {
      label: "Active Orders",
      value: metrics.active_orders.toString(),
      sub: "Live kitchen pipeline",
      color: "text-accent-600 dark:text-accent-400",
    },
  ];

  return (
    <div className="space-y-6">
      {totpEnabled === false && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 rounded-full bg-amber-500" aria-hidden="true" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Two-factor authentication is not enabled on this account.
            </p>
          </div>
          <Link
            href="/security"
            className="rounded-lg bg-amber-500 hover:bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors"
          >
            Enable 2FA
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-400 dark:text-neutral-500">Dashboard</h2>
        <span className="text-xs text-neutral-400">Auto-refresh 60s</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5"
          >
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{c.label}</p>
            <p className={`mt-1 text-2xl font-bold ${c.color}`}>{c.value}</p>
            <p className="mt-1 text-xs text-neutral-400">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-neutral-800 dark:text-neutral-200">
            Revenue — last 7 days
          </p>
          <span className="text-xs text-neutral-400">IST day buckets</span>
        </div>
        <p className="mt-1 text-xs text-neutral-400">
          Attributed to the day each order was placed (PICKED_UP / SETTLED, gross incl. GST). Days
          with no fulfilled orders show zero.
        </p>
        <div className="mt-4 space-y-2">
          {metrics.daily_series.map((p) => (
            <div
              key={p.date}
              className="flex items-center justify-between border-b border-neutral-100 py-1.5 text-sm last:border-0 dark:border-neutral-800"
            >
              <span className="font-mono text-neutral-500 dark:text-neutral-400">{p.date}</span>
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                {fmt(p.revenue)}
              </span>
              <span className="text-xs text-neutral-400">{p.fulfilled_orders} fulfilled</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <Link
          href="/orders"
          className="rounded-lg bg-primary-500 hover:bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          View Live Orders
        </Link>
        <Link
          href="/kill-switches"
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        >
          Kill Switches
        </Link>
      </div>
    </div>
  );
}
