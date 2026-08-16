"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchOrders, fetchInsights, type VendorOrder, type Insights } from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { ACTIVE_ORDER_STATUSES } from "@/lib/status";
import { formatINR, formatINRCompact, relativeTime, shortOrderId, isSameDay } from "@/lib/format";
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

function countToday(orders: VendorOrder[]) {
  return orders.filter((o) => isSameDay(o.created_at)).length;
}

function revenue(orders: VendorOrder[]) {
  const excluded = new Set(["CANCELLED", "PAYMENT_FAILED", "DRAFT", "REFUNDED"]);
  return orders.filter((o) => !excluded.has(o.status)).reduce((sum, o) => sum + o.total_amount, 0);
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
    const todays = orders.filter((o) => isSameDay(o.created_at));
    const todaysRevenue = revenue(todays);
    const active = orders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status));
    const aov = todays.length > 0 ? todaysRevenue / todays.length : 0;
    return { todays, todaysRevenue, active, aov };
  }, [orders]);

  const trend = useMemo(() => {
    const days: { label: string; total: number; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString("en-IN", { weekday: "short" });
      const dayOrders = orders.filter((o) => {
        const t = new Date(o.created_at);
        return (
          t.getFullYear() === d.getFullYear() &&
          t.getMonth() === d.getMonth() &&
          t.getDate() === d.getDate()
        );
      });
      days.push({ label, total: revenue(dayOrders), count: countToday(dayOrders) });
    }
    const max = Math.max(1, ...days.map((d) => d.total));
    return { days, max };
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
          label="Today's Revenue"
          value={formatINR(stats.todaysRevenue)}
          hint={`${stats.todays.length} paid orders`}
          accent="teal"
        />
        <StatCard
          label="Today's Orders"
          value={String(stats.todays.length)}
          hint="placed today"
          accent="blue"
        />
        <StatCard
          label="Active Orders"
          value={String(stats.active.length)}
          hint="in the kitchen pipeline"
          accent="amber"
        />
        <StatCard
          label="Avg Order Value"
          value={formatINR(stats.aov)}
          hint="today"
          accent="green"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard
          title="Revenue — last 7 days"
          subtitle="Daily total of paid orders"
          className="lg:col-span-2"
        >
          {trend.days.every((d) => d.total === 0) ? (
            <EmptyPanel
              title="No sales yet"
              description="Orders placed this week will appear here."
            />
          ) : (
            <div className="flex h-44 items-end gap-3">
              {trend.days.map((d) => (
                <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
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

        <SectionCard title="Today's payment split" subtitle="How customers paid">
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
