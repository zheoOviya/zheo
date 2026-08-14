"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchRevenue, fetchVendorMetrics, type RevenueReportDTO, type VendorMetricsDTO } from "../../../lib/api";

const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export default function RevenuePage() {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<RevenueReportDTO | null>(null);
  const [vendors, setVendors] = useState<VendorMetricsDTO[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setError("");
    setLoading(true);
    Promise.all([fetchRevenue(days), fetchVendorMetrics()])
      .then(([r, v]) => {
        setReport(r);
        setVendors(v);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load revenue"))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !report) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
      </div>
    );
  }

  const maxRevenue = report ? Math.max(...report.series.map((s) => s.revenue), 1) : 1;
  const paymentEntries = Object.entries(report?.payment_split ?? {}).sort((a, b) => b[1] - a[1]);
  const totalPayments = paymentEntries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Revenue Analytics</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Daily revenue, payment mix, and vendor settlement. Auto-refreshes every 60s.</p>
        </div>
        <div className="flex gap-2">
          {[7, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                days === d
                  ? "bg-primary-500 text-white"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Revenue ({days}d)</p>
              <p className="mt-1 text-2xl font-bold text-primary-600 dark:text-primary-400">{fmt(report.totals.revenue)}</p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Orders ({days}d)</p>
              <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{report.totals.orders}</p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Platform Commission</p>
              <p className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">{fmt(report.totals.commission)}</p>
            </div>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Avg Order Value</p>
              <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{fmt(report.totals.average_order_value)}</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="mb-4 font-semibold text-neutral-800 dark:text-neutral-200">Daily Revenue</p>
              <div className="flex h-40 items-end gap-1.5">
                {report.series.map((s) => (
                  <div key={s.date} className="group flex flex-1 flex-col items-center gap-1">
                    <div className="relative flex w-full flex-1 items-end">
                      <div
                        className="w-full rounded-t bg-primary-500/80 group-hover:bg-primary-500 transition-colors"
                        style={{ height: `${Math.max((s.revenue / maxRevenue) * 100, 2)}%` }}
                        title={`${s.date}: Rs.${s.revenue.toFixed(0)} / ${s.orders} orders`}
                      />
                    </div>
                    <span className="text-[10px] text-neutral-400">{s.date.slice(5)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-neutral-400">Hover a bar for the daily total.</p>
            </div>

            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="mb-4 font-semibold text-neutral-800 dark:text-neutral-200">Payment Mix</p>
              {paymentEntries.length === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-400">No completed payments in this window.</p>
              ) : (
                <div className="space-y-3">
                  {paymentEntries.map(([method, count]) => {
                    const pct = totalPayments > 0 ? Math.round((count / totalPayments) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-neutral-600 dark:text-neutral-300">{method.toUpperCase()}</span>
                          <span className="text-neutral-400">{count}</span>
                        </div>
                        <div className="mt-1 h-2 rounded-full bg-neutral-100 dark:bg-neutral-800">
                          <div className="h-2 rounded-full bg-primary-500/70" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">Top Vendors</p>
              {report.top_vendors.length === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-400">No vendor revenue in this window.</p>
              ) : (
                <div className="space-y-2">
                  {report.top_vendors.map((v) => (
                    <div key={v.restaurant_id} className="flex items-center justify-between rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                      <p className="min-w-0 truncate text-neutral-700 dark:text-neutral-300">{v.name}</p>
                      <p className="ml-3 shrink-0 font-mono text-xs tabular-nums text-neutral-500">{v.orders} orders · Rs.{v.revenue.toFixed(0)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
              <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">Vendor Settlement</p>
              {vendors.length === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-400">No vendors onboarded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-neutral-200 dark:border-neutral-800">
                      <tr>
                        <th className="py-2 pr-3 text-neutral-500">Vendor</th>
                        <th className="py-2 pr-3 text-neutral-500">Orders</th>
                        <th className="py-2 pr-3 text-neutral-500">Revenue</th>
                        <th className="py-2 pr-3 text-neutral-500">Commission</th>
                        <th className="py-2 pr-3 text-neutral-500">Active</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {vendors.map((v) => (
                        <tr key={v.id} className="text-neutral-700 dark:text-neutral-300">
                          <td className="py-2 pr-3">
                            <p className="font-medium">{v.name}</p>
                            <p className="text-neutral-400">rate {Math.round(v.commission_rate * 100)}%</p>
                          </td>
                          <td className="py-2 pr-3 tabular-nums">{v.completed_orders}</td>
                          <td className="py-2 pr-3 font-mono tabular-nums">{fmt(v.revenue)}</td>
                          <td className="py-2 pr-3 font-mono tabular-nums">{fmt(v.commission)}</td>
                          <td className="py-2 pr-3">
                            <span className={`inline-block rounded-full px-2 py-0.5 font-semibold ${v.is_active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}>
                              {v.is_active ? "Active" : "Suspended"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
