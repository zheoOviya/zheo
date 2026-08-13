"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSettlementSummary, downloadSettlementPdf, type SettlementSummary } from "@/lib/api";
import { formatINR, formatDate } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  StatCard,
  ErrorBanner,
  Spinner,
  EmptyPanel,
  PrimaryButton,
} from "@/components/ui";

export default function SettlementsPage() {
  const [summary, setSummary] = useState<SettlementSummary | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchSettlementSummary());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settlement summary");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDownload() {
    setDownloading(true);
    setError("");
    try {
      await downloadSettlementPdf();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download the PDF report");
    } finally {
      setDownloading(false);
    }
  }

  if (!summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settlements" subtitle="Daily payout reconciliation" />
        <ErrorBanner message={error} />
        <div className="flex h-64 items-center justify-center">
          <Spinner className="h-8 w-8" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settlements"
        subtitle={`Settlement for ${formatDate(summary.period_start)}`}
        actions={
          <PrimaryButton onClick={handleDownload} disabled={downloading}>
            {downloading ? "Generating..." : "Download PDF Report"}
          </PrimaryButton>
        }
      />

      <ErrorBanner message={error} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Orders Settled" value={String(summary.order_count)} accent="blue" />
        <StatCard label="Commission" value={formatINR(summary.total_commission)} accent="amber" />
        <StatCard label="Net Payout" value={formatINR(summary.net_payout)} accent="green" />
      </div>

      <SectionCard
        title="Order Breakdown"
        subtitle="Commission, taxes and payout per settled order"
      >
        {summary.lines.length === 0 ? (
          <EmptyPanel
            title="No settled orders"
            description="No picked-up orders in this settlement window."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {summary.lines.map((line) => (
              <li
                key={line.order_id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div>
                  <p className="font-mono text-sm font-semibold text-slate-800">
                    {line.order_number}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Commission {formatINR(line.commission_amount)} · Tax {formatINR(line.taxes)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-slate-800">
                    {formatINR(line.total_amount)}
                  </p>
                  <p className="mt-0.5 text-xs font-medium text-emerald-600">
                    Payout {formatINR(line.payout)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <p className="text-xs text-slate-400">
        GST 5% on food and 18% on packaging, packaging Rs 10 per item. Commission: 0% for orders up
        to Rs 200, 8% above. Payout = order value - commission - taxes.
      </p>
    </div>
  );
}
