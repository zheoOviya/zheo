"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchInsights, type Insights } from "@/lib/api";
import { formatINR } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  StatCard,
  FilterChip,
  ErrorBanner,
  Spinner,
  EmptyPanel,
} from "@/components/ui";

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

export default function InsightsPage() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (windowDays: number) => {
    setLoading(true);
    setError("");
    try {
      setInsights(await fetchInsights(windowDays));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const maxCount = Math.max(1, ...(insights?.peak_hours.map((b) => b.order_count) ?? [0]));

  if (loading && !insights) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Insights"
        subtitle="Repeat rate, average order value and peak hours from completed orders"
        actions={
          <div className="flex gap-1.5">
            {PERIODS.map((period) => (
              <FilterChip
                key={period.days}
                label={period.label}
                active={days === period.days}
                onClick={() => setDays(period.days)}
              />
            ))}
          </div>
        }
      />

      <ErrorBanner message={error} />

      {!insights ? null : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Average Order Value"
              value={formatINR(insights.aov)}
              hint={`${insights.order_count} orders`}
              accent="teal"
            />
            <StatCard
              label="Repeat Rate"
              value={`${Math.round(insights.repeat_rate * 100)}%`}
              hint={`${insights.repeat_customers} of ${insights.total_customers} customers`}
              accent="green"
            />
            <StatCard
              label="Revenue"
              value={formatINR(insights.total_revenue)}
              hint={`last ${insights.days} days`}
              accent="amber"
            />
            <StatCard
              label="Total Orders"
              value={String(insights.order_count)}
              hint="completed only"
              accent="blue"
            />
          </div>

          <SectionCard
            title="Peak Ordering Hours (IST)"
            subtitle="Busiest hours in the selected window"
          >
            {maxCount <= 1 ? (
              <EmptyPanel
                title="Not enough data"
                description="More completed orders will reveal peak hours."
              />
            ) : (
              <div className="space-y-2">
                {insights.peak_hours.map((bucket) => (
                  <div key={bucket.hour} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-500">
                      {bucket.label}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${
                          bucket.order_count === maxCount ? "bg-amber-400" : "bg-teal-600/70"
                        }`}
                        style={{
                          width: `${(bucket.order_count / maxCount) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-xs tabular-nums text-slate-500">
                      {bucket.order_count || ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
