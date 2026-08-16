"use client";

import { useState } from "react";
import { downloadGstCsv } from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { PageHeader, SectionCard, ErrorBanner, PrimaryButton } from "@/components/ui";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function GstPage() {
  const [month, setMonth] = useState(currentMonth());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { activeRestaurantId } = useActiveRestaurant();

  async function handleDownload() {
    if (!activeRestaurantId) return;
    setDownloading(true);
    setError("");
    setMessage("");
    try {
      await downloadGstCsv(month, activeRestaurantId);
      setMessage(`GSTR-1 CSV for ${month} downloaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate the GST report");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="GST Reports"
        subtitle="Download a GSTR-1 ready CSV of settled orders for any month"
      />

      <ErrorBanner message={error} />

      {message && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {message}
        </div>
      )}

      <SectionCard title="Download GSTR-1 CSV">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Reporting month</span>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <PrimaryButton onClick={handleDownload} disabled={downloading || !month}>
            {downloading ? "Preparing..." : "Download CSV"}
          </PrimaryButton>
        </div>
      </SectionCard>

      <SectionCard title="Format">
        <p className="text-sm leading-relaxed text-slate-500">
          Each row is one settled invoice: Invoice No, GSTIN, Date, Taxable Value, CGST 2.5%, SGST
          2.5% (5% food GST split). Taxable value is recomputed from order items. Restaurant
          services fall under SAC 996321 with 5% GST (2.5% CGST + 2.5% SGST for intra-state).
        </p>
      </SectionCard>
    </div>
  );
}
