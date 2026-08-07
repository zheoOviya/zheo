"use client";

import { useCallback, useEffect, useState } from "react";
import TealSkeleton from "@/components/TealSkeleton";
import { formatINR } from "@/lib/format";

interface PeakHour {
  hour: number;
  label: string;
  order_count: number;
}

interface Insights {
  days: number;
  order_count: number;
  total_revenue: number;
  aov: number;
  repeat_rate: number;
  repeat_customers: number;
  total_customers: number;
  peak_hours: PeakHour[];
}

const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

function StatCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        accent
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-primary-500/15 bg-primary-900/30"
      }`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-primary-600/60">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-bold ${
          accent ? "text-amber-300" : "text-primary-400"
        }`}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-xs text-primary-600/60">{sub}</p> : null}
    </div>
  );
}

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchInsights = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/vendor/insights?restaurant_id=${RESTAURANT_ID}&days=${windowDays}`,
      );
      const body = await res.json();
      if (body.success) setInsights(body.data);
      else setError(body.error?.message ?? "Failed to load insights");
    } catch {
      setError("Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInsights(days);
  }, [days, fetchInsights]);

  const maxCount = Math.max(
    1,
    ...(insights?.peak_hours.map((b) => b.order_count) ?? [0]),
  );
  const topHour = insights
    ? insights.peak_hours.reduce<PeakHour | null>(
        (best, bucket) =>
          !best || bucket.order_count > best.order_count ? bucket : best,
        null,
      )
    : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">
          Customer Insights
        </h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Repeat rate, average order value and peak hours from completed orders.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-2">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            onClick={() => setDays(period.days)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              days === period.days
                ? "bg-primary-500/20 text-primary-300"
                : "text-primary-600/60 hover:text-primary-400"
            }`}
          >
            {period.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <TealSkeleton className="h-24" />
            <TealSkeleton className="h-24" />
            <TealSkeleton className="h-24" />
            <TealSkeleton className="h-24" />
          </div>
          <TealSkeleton className="h-64" />
        </div>
      ) : error ? (
        <p className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </p>
      ) : insights ? (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label="Average Order Value"
              value={formatINR(insights.aov)}
              sub={`${insights.order_count} orders`}
            />
            <StatCard
              label="Repeat Rate"
              value={`${Math.round(insights.repeat_rate * 100)}%`}
              sub={`${insights.repeat_customers} of ${insights.total_customers} customers`}
              accent
            />
            <StatCard
              label="Revenue"
              value={formatINR(insights.total_revenue)}
              sub={`last ${insights.days} days`}
            />
            <StatCard
              label="Total Orders"
              value={String(insights.order_count)}
              sub="completed only"
            />
          </div>

          <section className="mt-6 rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <h2 className="mb-3 text-sm font-semibold text-primary-400">
              Peak Ordering Hours (IST)
            </h2>
            <div className="space-y-1.5">
              {insights.peak_hours.map((bucket) => {
                const isTop = topHour && bucket.hour === topHour.hour;
                const width =
                  bucket.order_count > 0
                    ? (bucket.order_count / maxCount) * 100
                    : 0;
                return (
                  <div key={bucket.hour} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-right text-xs text-primary-600/60">
                      {bucket.label}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-primary-500/10">
                      <div
                        className={`h-full rounded ${
                          isTop
                            ? "bg-amber-400/80"
                            : "bg-primary-500/60"
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-xs text-primary-400">
                      {bucket.order_count || ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
