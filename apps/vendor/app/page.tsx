"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchOrders, fetchInsights, type VendorOrder, type Insights } from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { ACTIVE_ORDER_STATUSES } from "@/lib/status";
import { formatINR, formatINRCompact, relativeTime, shortOrderId } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusBadge,
  PaymentBadge,
  EmptyPanel,
  ErrorBanner,
  Spinner,
} from "@/components/ui";

// Frozen vendor truth: an order only counts as a sale once it is
// fulfilled, i.e. PICKED_UP or SETTLED. In-flight orders
// (CONFIRMED..READY_FOR_PICKUP) and abandoned/failed carts are excluded.
const FULFILLED_STATUSES = new Set<VendorOrder["status"]>(["PICKED_UP", "SETTLED"]);

// Deterministic IST (+05:30) calendar bucketing so "today" and the 7-day
// trend never drift with the viewer's browser timezone (India has no DST).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDayKey(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function istTodayKey(ref = new Date()): string {
  return istDayKey(ref.toISOString());
}

function istDayKeys(days: number, ref = new Date()): { key: string; label: string }[] {
  const shifted = new Date(ref.getTime() + IST_OFFSET_MS);
  const keys: { key: string; label: string }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - i),
    );
    keys.push({
      key: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }),
    });
  }
  return keys;
}

export default function OverviewPage() {
  const [orders, setOrders] = useState<VendorOrder[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { activeRestaurantId } = useActiveRestaurant();

  useEffect(() => {
    if (!activeRestaurantId) return;
    let cancelled = false;
    (async () => {
      try {
        const [all, insight] = await Promise.all([
          fetchOrders({ scope: "all" }, activeRestaurantId),
          fetchInsights(7, activeRestaurantId),
        ]);
        if (cancelled) return;
        setOrders(all);
        setInsights(insight);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRestaurantId]);

  const stats = useMemo(() => {
    const todayKey = istTodayKey();
    const todays = orders.filter((o) => istDayKey(o.created_at) === todayKey);
    const todaysFulfilled = todays.filter((o) => FULFILLED_STATUSES.has(o.status));
    const todaysRevenue = todaysFulfilled.reduce((sum, o) => sum + o.total_amount, 0);
    const active = orders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status));
    // AOV numerator and denominator use the SAME fulfilled population.
    const aov = todaysFulfilled.length > 0 ? todaysRevenue / todaysFulfilled.length : 0;
    return { todays, todaysFulfilled, todaysRevenue, active, aov };
  }, [orders]);

  const trend = useMemo(() => {
    const buckets = istDayKeys(7).map(({ key, label }) => ({
      key,
      label,
      total: 0,
      count: 0,
    }));
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const o of orders) {
      if (!FULFILLED_STATUSES.has(o.status)) continue;
      const bucket = byKey.get(istDayKey(o.created_at));
      if (!bucket) continue;
      bucket.total += o.total_amount;
      bucket.count += 1;
    }
    const max = Math.max(1, ...buckets.map((d) => d.total));
    return { days: buckets, max };
  }, [orders]);

  const paymentSplit = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of stats.todays) {
      const key = o.payment_method ?? "unknown";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count);
  }, [stats.todays]);

  const statusBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of orders) {
      counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
  }, [orders]);

  const recent = useMemo(
    () =>
      [...orders]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [orders],
  );

  const peakHours = insights?.peak_hours ?? [];
  const peakMax = Math.max(1, ...peakHours.map((p) => p.order_count));

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle="How the kitchen is doing today"
        actions={
          <Link
            href="/orders"
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            View all orders
          </Link>
        }
      />

      <ErrorBanner message={error} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Today's Fulfilled Sales"
          value={formatINR(stats.todaysRevenue)}
          hint={`${stats.todaysFulfilled.length} fulfilled orders`}
          accent="teal"
        />
        <StatCard
          label="Today's Orders"
          value={String(stats.todays.length)}
          hint="placed today (IST)"
          accent="blue"
        />
        <StatCard
          label="Active Orders"
          value={String(stats.active.length)}
          hint="in the kitchen pipeline"
          accent="amber"
        />
        <StatCard
          label="Avg Fulfilled Order Value"
          value={formatINR(stats.aov)}
          hint="today"
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard
          title="Fulfilled Sales — last 7 days"
          subtitle="Daily total of fulfilled orders (picked up or settled)"
          className="lg:col-span-2"
        >
          {trend.days.every((d) => d.total === 0) ? (
            <EmptyPanel
              title="No fulfilled sales yet"
              description="Fulfilled orders from the last 7 days will appear here."
            />
          ) : (
            <div className="flex h-44 items-end gap-3">
              {trend.days.map((d) => (
                <div key={d.key} className="flex flex-1 flex-col items-center gap-1.5">
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t-md bg-teal-600/80 transition-all"
                      style={{ height: `${Math.max(4, (d.total / trend.max) * 100)}%` }}
                      aria-hidden="true"
                    />
                  </div>
                  <span className="text-[11px] font-medium text-slate-500">{d.label}</span>
                  <span className="text-[11px] tabular-nums text-slate-400">
                    {formatINRCompact(d.total)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Today's payment split" subtitle="Payment methods used today">
          {paymentSplit.length === 0 ? (
            <EmptyPanel
              title="No payments today"
              description="Payment methods will show up here."
            />
          ) : (
            <ul className="space-y-3">
              {paymentSplit.map((p) => (
                <li key={p.method} className="flex items-center justify-between">
                  <PaymentBadge method={p.method as VendorOrder["payment_method"]} />
                  <span className="text-sm font-semibold tabular-nums text-slate-700">
                    {p.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard title="Orders by status" subtitle="Across all history">
          {statusBreakdown.length === 0 ? (
            <EmptyPanel
              title="No orders yet"
              description="Place an order on the consumer app to see it here."
            />
          ) : (
            <ul className="space-y-2">
              {statusBreakdown.map((s) => (
                <li key={s.status} className="flex items-center justify-between">
                  <StatusBadge status={s.status as VendorOrder["status"]} />
                  <span className="text-sm font-semibold tabular-nums text-slate-700">
                    {s.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Peak hours"
          subtitle="Order volume in the last 7 days"
          className="lg:col-span-2"
        >
          {peakMax <= 1 ? (
            <EmptyPanel title="Not enough data" description="More orders will reveal peak hours." />
          ) : (
            <div className="space-y-2">
              {peakHours.map((p) => (
                <div key={p.hour} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-xs tabular-nums text-slate-500">
                    {p.label}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-teal-600/70"
                      style={{ width: `${(p.order_count / peakMax) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-500">
                    {p.order_count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Recent orders"
        subtitle="Latest activity"
        actions={
          <Link href="/kds" className="text-sm font-semibold text-teal-600 hover:text-teal-700">
            Live orders →
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyPanel
            title="No orders yet"
            description="Place a test order from the SnakZap consumer app and it will show up here."
            cta={
              <Link href="/kds" className="text-sm font-semibold text-teal-600 hover:text-teal-700">
                Open the kitchen display
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-sm font-bold text-slate-800">
                    #{shortOrderId(o.id)}
                  </span>
                  <span className="hidden text-xs text-slate-400 sm:inline">
                    {o.items.length} item{o.items.length !== 1 ? "s" : ""}
                    {o.is_catering ? " · Catering" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden text-xs text-slate-400 md:inline">
                    {relativeTime(o.created_at)}
                  </span>
                  <PaymentBadge method={o.payment_method} />
                  <StatusBadge status={o.status} />
                  <span className="text-sm font-semibold tabular-nums text-slate-700">
                    {formatINR(o.total_amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
