"use client";

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@snakzap/ui";
import { formatINR } from "@/lib/format";
import { authedFetch } from "@/lib/cateringAuth";

interface ChainSummary {
  id: string;
  name: string;
  outlets: { restaurant_id: string; name: string }[];
}

interface OutletAggregate {
  restaurant_id: string;
  name: string;
  order_count: number;
  revenue: number;
  aov: number;
  share: number;
}

interface ChainAggregate {
  chain_id: string;
  chain_name: string;
  outlet_count: number;
  total_orders: number;
  total_revenue: number;
  combined_aov: number;
  outlets: OutletAggregate[];
}

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

export default function ChainOverviewPage() {
  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [chainId, setChainId] = useState("");
  const [outletId, setOutletId] = useState("all");
  const [insights, setInsights] = useState<ChainAggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch("/api/vendor/chains");
        const body = await res.json();
        if (body.success) {
          setChains(body.data);
          if (body.data.length > 0) setChainId(body.data[0].id);
        } else {
          setError(body.error?.message ?? "Failed to load chains");
        }
      } catch {
        setError("Failed to load chains");
      }
    })();
  }, []);

  const fetchInsights = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await authedFetch(
        `/api/vendor/chains/${id}/aggregate-insights`,
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
    if (chainId) fetchInsights(chainId);
  }, [chainId, fetchInsights]);

  const selectedOutlet =
    outletId === "all"
      ? null
      : insights?.outlets.find((o) => o.restaurant_id === outletId) ?? null;

  const maxRevenue = Math.max(
    1,
    ...(insights?.outlets.map((o) => o.revenue) ?? [0]),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">Chain Overview</h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Aggregate orders, revenue and AOV across every outlet in your chain.
        </p>
      </header>

      {chains.length === 0 && !loading && !error ? (
        <p className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4 text-sm text-primary-600/60">
          No chains found for this account. Create a chain to see the
          multi-outlet dashboard.
        </p>
      ) : null}

      {chains.length > 0 ? (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">Chain</span>
            <select
              value={chainId}
              onChange={(e) => setChainId(e.target.value)}
              className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
            >
              {chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">Outlet</span>
            <select
              value={outletId}
              onChange={(e) => setOutletId(e.target.value)}
              className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
            >
              <option value="all">All Outlets</option>
              {insights?.outlets.map((o) => (
                <option key={o.restaurant_id} value={o.restaurant_id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : error ? (
        <p className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </p>
      ) : insights ? (
        <>
          {selectedOutlet ? (
            <div className="grid grid-cols-3 gap-4">
              <StatCard
                label="Orders"
                value={String(selectedOutlet.order_count)}
                sub={selectedOutlet.name}
              />
              <StatCard
                label="Revenue"
                value={formatINR(selectedOutlet.revenue)}
                sub={`${selectedOutlet.share}% of chain`}
              />
              <StatCard
                label="AOV"
                value={formatINR(selectedOutlet.aov)}
                sub="average order value"
                accent
              />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              <StatCard
                label="Total Orders"
                value={String(insights.total_orders)}
                sub={`${insights.outlet_count} outlets`}
              />
              <StatCard
                label="Total Revenue"
                value={formatINR(insights.total_revenue)}
                sub="all outlets combined"
              />
              <StatCard
                label="Combined AOV"
                value={formatINR(insights.combined_aov)}
                sub="chain-wide average"
                accent
              />
            </div>
          )}

          <section className="mt-6 rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <h2 className="mb-1 text-sm font-semibold text-primary-400">
              Outlet Comparison
            </h2>
            <p className="mb-4 text-xs text-primary-600/60">
              {selectedOutlet
                ? `${selectedOutlet.name} vs chain total`
                : "Revenue share across outlets"}
            </p>
            <div className="space-y-4">
              {insights.outlets.map((outlet) => {
                const isSelected =
                  selectedOutlet?.restaurant_id === outlet.restaurant_id;
                const width = (outlet.revenue / maxRevenue) * 100;
                return (
                  <div key={outlet.restaurant_id}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span
                        className={
                          isSelected
                            ? "font-semibold text-primary-300"
                            : "text-primary-600/60"
                        }
                      >
                        {outlet.name}
                      </span>
                      <span className="text-primary-400">
                        {formatINR(outlet.revenue)}{" "}
                        <span className="text-primary-600/50">
                          ({outlet.share}%)
                        </span>
                      </span>
                    </div>
                    <div className="h-4 overflow-hidden rounded bg-primary-500/10">
                      <div
                        className={`h-full rounded ${
                          isSelected ? "bg-amber-400/80" : "bg-primary-500/60"
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[11px] text-primary-600/50">
                      {outlet.order_count} orders &middot; AOV{" "}
                      {formatINR(outlet.aov)}
                    </p>
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
