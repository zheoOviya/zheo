"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchChains,
  fetchChainAggregate,
  type Chain,
  type ChainAggregateInsights,
} from "@/lib/api";
import { formatINR } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  StatCard,
  ErrorBanner,
  Spinner,
  EmptyPanel,
} from "@/components/ui";

export default function ChainOverviewPage() {
  const [chains, setChains] = useState<Chain[]>([]);
  const [chainId, setChainId] = useState("");
  const [outletId, setOutletId] = useState("all");
  const [insights, setInsights] = useState<ChainAggregateInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchChains();
        setChains(data);
        const first = data[0];
        if (first) setChainId(first.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load chains");
      }
    })();
  }, []);

  const loadInsights = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      setInsights(await fetchChainAggregate(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load insights");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (chainId) loadInsights(chainId);
  }, [chainId, loadInsights]);

  const selectedOutlet =
    outletId === "all"
      ? null
      : (insights?.outlets.find((o) => o.restaurant_id === outletId) ?? null);

  const maxRevenue = Math.max(1, ...(insights?.outlets.map((o) => o.revenue) ?? [0]));

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
        title="Chain Overview"
        subtitle="Aggregate orders, revenue and AOV across every outlet in your chain"
      />

      <ErrorBanner message={error} />

      {chains.length === 0 ? (
        <EmptyPanel
          title="No chains found"
          description="Create a chain to see the multi-outlet dashboard."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Chain</span>
              <select
                value={chainId}
                onChange={(e) => setChainId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
              >
                {chains.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Outlet</span>
              <select
                value={outletId}
                onChange={(e) => setOutletId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
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

          {insights && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {selectedOutlet ? (
                  <>
                    <StatCard
                      label="Orders"
                      value={String(selectedOutlet.order_count)}
                      hint={selectedOutlet.name}
                      accent="blue"
                    />
                    <StatCard
                      label="Revenue"
                      value={formatINR(selectedOutlet.revenue)}
                      hint={`${selectedOutlet.share}% of chain`}
                      accent="teal"
                    />
                    <StatCard
                      label="AOV"
                      value={formatINR(selectedOutlet.aov)}
                      hint="average order value"
                      accent="green"
                    />
                  </>
                ) : (
                  <>
                    <StatCard
                      label="Total Orders"
                      value={String(insights.total_orders)}
                      hint={`${insights.outlet_count} outlets`}
                      accent="blue"
                    />
                    <StatCard
                      label="Total Revenue"
                      value={formatINR(insights.total_revenue)}
                      hint="all outlets combined"
                      accent="teal"
                    />
                    <StatCard
                      label="Combined AOV"
                      value={formatINR(insights.combined_aov)}
                      hint="chain-wide average"
                      accent="green"
                    />
                  </>
                )}
              </div>

              <SectionCard
                title="Outlet Comparison"
                subtitle={
                  selectedOutlet
                    ? `${selectedOutlet.name} vs chain total`
                    : "Revenue share across outlets"
                }
              >
                <div className="space-y-4">
                  {insights.outlets.map((outlet) => {
                    const isSelected = selectedOutlet?.restaurant_id === outlet.restaurant_id;
                    return (
                      <div key={outlet.restaurant_id}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span
                            className={
                              isSelected ? "font-semibold text-teal-700" : "text-slate-600"
                            }
                          >
                            {outlet.name}
                          </span>
                          <span className="text-slate-700">
                            {formatINR(outlet.revenue)}{" "}
                            <span className="text-slate-400">({outlet.share}%)</span>
                          </span>
                        </div>
                        <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full ${isSelected ? "bg-amber-400" : "bg-teal-600/70"}`}
                            style={{ width: `${(outlet.revenue / maxRevenue) * 100}%` }}
                          />
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {outlet.order_count} orders · AOV {formatINR(outlet.aov)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            </>
          )}
        </>
      )}
    </div>
  );
}
