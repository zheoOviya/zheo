"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchDashboardMetrics, type DashboardMetrics } from "../../../lib/api";
import { getTotpStatus } from "../../../lib/totp";
import Link from "next/link";

const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const min = 0;
  const range = max - min || 1;
  const width = 70;
  const height = 24;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} className="inline-block ml-2">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

const TREND_WEEKLY = [120, 85, 210, 95, 180, 70, 260];
const TREND_DECREASING = [300, 290, 250, 220, 200, 180, 150];

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
          <div key={i} className="h-24 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        ))}
      </div>
    );
  }

  const vendorChurnColor = metrics.vendor_churn_pct > 5 ? "#ef4444" : "#0D9488";
  const webhookColor = metrics.webhook_failure_pct > 0.5 ? "#f59e0b" : "#0D9488";

  const cards = [
    {
      label: "Daily Revenue",
      value: fmt(metrics.daily_revenue),
      color: "text-primary-600 dark:text-primary-400",
      trend: TREND_WEEKLY,
      trendColor: "#0D9488",
    },
    {
      label: "Active Orders",
      value: metrics.active_orders.toString(),
      color: "text-accent-600 dark:text-accent-400",
      trend: TREND_WEEKLY,
      trendColor: "#f59e0b",
    },
    {
      label: "Orders Today",
      value: metrics.total_orders_today.toString(),
      color: "text-neutral-900 dark:text-neutral-100",
      trend: TREND_WEEKLY,
      trendColor: "#6b7280",
    },
    {
      label: "Avg Pickup Time",
      value: `${metrics.avg_pickup_time_min} min`,
      color: "text-neutral-700 dark:text-neutral-300",
      trend: TREND_DECREASING,
      trendColor: "#22c55e",
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
        <h2 className="text-lg font-semibold text-neutral-400 dark:text-neutral-500">
          Dashboard
        </h2>
        <span className="text-xs text-neutral-400">Auto-refresh 60s</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5"
          >
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{c.label}</p>
            <div className="flex items-center">
              <p className={`mt-1 text-2xl font-bold ${c.color}`}>{c.value}</p>
              <Sparkline values={c.trend} color={c.trendColor} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Vendor Churn</p>
          <div className="flex items-center">
            <p className={`mt-1 text-2xl font-bold`} style={{ color: vendorChurnColor }}>
              {metrics.vendor_churn_pct}%
            </p>
            <Sparkline values={[2.0, 2.5, 2.1, 1.8, 2.9, 2.3, metrics.vendor_churn_pct] as number[]} color={vendorChurnColor} />
          </div>
          <p className="mt-1 text-xs text-neutral-400">Threshold: 10%</p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Webhook Failures</p>
          <div className="flex items-center">
            <p className={`mt-1 text-2xl font-bold`} style={{ color: webhookColor }}>
              {metrics.webhook_failure_pct}%
            </p>
            <Sparkline values={[0.1, 0.2, 0.08, 0.15, 0.05, 0.12, metrics.webhook_failure_pct] as number[]} color={webhookColor} />
          </div>
          <p className="mt-1 text-xs text-neutral-400">Threshold: 1%</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">CAC (per user)</p>
          <div className="flex items-center">
            <p className="mt-1 text-2xl font-bold text-neutral-700 dark:text-neutral-300">
              {fmt(metrics.cac_amount)}
            </p>
            <Sparkline values={TREND_DECREASING} color="#6b7280" />
          </div>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">LTV (6 mo est.)</p>
          <div className="flex items-center">
            <p className="mt-1 text-2xl font-bold text-primary-600 dark:text-primary-400">
              {fmt(metrics.ltv_amount)}
            </p>
            <Sparkline values={TREND_WEEKLY} color="#0D9488" />
          </div>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">CAC / LTV Ratio</p>
          <div className="flex items-center">
            <p className={`mt-1 text-2xl font-bold ${metrics.cac_ltv_ratio > 1 ? "text-red-500" : "text-primary-500"}`}>
              {metrics.cac_ltv_ratio.toFixed(2)}
            </p>
            <Sparkline values={[1.2, 0.9, 0.85, 1.0, 0.7, 0.6, metrics.cac_ltv_ratio] as number[]} color={metrics.cac_ltv_ratio > 1 ? "#ef4444" : "#0D9488"} />
          </div>
          <p className="mt-1 text-xs text-neutral-400">Healthy if &lt; 1.0</p>
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
