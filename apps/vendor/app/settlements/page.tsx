"use client";

import { useCallback, useEffect, useState } from "react";
import TealSkeleton from "@/components/TealSkeleton";
import { formatINR } from "@/lib/format";

interface SettlementSummary {
  period_start: string;
  period_end: string;
  order_count: number;
  total_food_subtotal: number;
  total_packaging_fee: number;
  total_gst_food: number;
  total_gst_packaging: number;
  total_commission: number;
  total_taxes: number;
  net_payout: number;
  lines: Array<{
    order_id: string;
    order_number: string;
    total_amount: number;
    commission_amount: number;
    taxes: number;
    payout: number;
  }>;
}

const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

export default function SettlementsPage() {
  const [summary, setSummary] = useState<SettlementSummary | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/vendor/settlements/summary?restaurant_id=${RESTAURANT_ID}`,
      );
      const body = await res.json();
      if (body.success) setSummary(body.data);
    } catch {
      setError("Failed to load settlement summary");
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  async function downloadPdf() {
    setDownloading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/vendor/settlements/today?restaurant_id=${RESTAURANT_ID}`,
        { method: "PUT" },
      );
      if (!res.ok) {
        setError("Failed to generate the PDF report");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `settlement-${(summary?.period_start ?? "").slice(0, 10) || "today"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download the PDF report");
    } finally {
      setDownloading(false);
    }
  }

  const periodLabel = summary
    ? new Date(summary.period_start).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary-400">Daily Settlements</h1>
          <p className="mt-1 text-sm text-primary-600/50">
            {summary
              ? `Settlement for ${periodLabel} (UTC)`
              : "Loading settlement period..."}
          </p>
        </div>
        <button
          type="button"
          onClick={downloadPdf}
          disabled={downloading || !summary}
          className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:opacity-40 active:scale-95 transition-transform"
        >
          {downloading ? "Generating..." : "Download PDF Report"}
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {!summary ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TealSkeleton className="h-28" />
          <TealSkeleton className="h-28" />
          <TealSkeleton className="h-28" />
          <TealSkeleton className="h-64 sm:col-span-3" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-primary-900/30 border border-primary-500/10 p-4">
              <p className="text-xs text-primary-600/60">Orders Settled</p>
              <p className="mt-1 text-2xl font-bold text-primary-300">
                {summary.order_count}
              </p>
            </div>
            <div className="rounded-2xl bg-primary-900/30 border border-primary-500/10 p-4">
              <p className="text-xs text-primary-600/60">Commission</p>
              <p className="mt-1 text-2xl font-bold text-accent-400">
                {formatINR(summary.total_commission)}
              </p>
            </div>
            <div className="rounded-2xl bg-primary-500/10 border border-primary-500/30 p-4">
              <p className="text-xs text-primary-600/60">Net Payout</p>
              <p className="mt-1 text-2xl font-bold text-green-400">
                {formatINR(summary.net_payout)}
              </p>
            </div>
          </div>

          <section className="mt-6">
            <h2 className="mb-3 text-lg font-semibold text-primary-300">
              Order Breakdown
            </h2>
            {summary.lines.length === 0 ? (
              <p className="py-8 text-center text-sm text-primary-600/30">
                No picked-up orders in this settlement window
              </p>
            ) : (
              <div className="space-y-2">
                {summary.lines.map((line) => (
                  <div
                    key={line.order_id}
                    className="flex items-center justify-between rounded-xl bg-primary-900/30 border border-primary-500/10 px-4 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium text-neutral-200">
                        {line.order_number}
                      </p>
                      <p className="mt-0.5 text-xs text-primary-600/50">
                        Commission {formatINR(line.commission_amount)} &middot; Tax{" "}
                        {formatINR(line.taxes)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-neutral-300">{formatINR(line.total_amount)}</p>
                      <p className="mt-0.5 text-xs text-green-400">
                        Payout {formatINR(line.payout)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <p className="mt-6 text-xs text-primary-600/30">
            GST 5% on food and 18% on packaging, Rs 10 per item packaging. Commission: 0% for
            orders up to Rs 200, 8% above. Payout = order value - commission - taxes.
          </p>
        </>
      )}
    </main>
  );
}
