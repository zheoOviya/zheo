"use client";

import { useState } from "react";
import { Skeleton } from "@snakzap/ui";
import { RESTAURANT_ID } from "@/lib/constants";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function GstPage() {
  const [month, setMonth] = useState(currentMonth());
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function download() {
    setDownloading(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(
        `/api/vendor/gst-export?month=${month}&restaurant_id=${RESTAURANT_ID}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to generate the GST report");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `gstr1-${month}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMessage(`GSTR-1 CSV for ${month} downloaded.`);
    } catch {
      setError("Failed to generate the GST report");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">GST Compliance</h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Download a GSTR-1 ready CSV of settled orders for any month.
        </p>
      </header>

      <div className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
        <label
          htmlFor="gst-month"
          className="mb-1 block text-sm font-medium text-primary-400"
        >
          Reporting month
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="gst-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 focus:border-primary-500 focus:outline-none"
          />
          <button
            onClick={download}
            disabled={downloading || !month}
            className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-60"
          >
            {downloading ? (
              <span className="inline-flex items-center gap-2">
                <Skeleton className="h-3 w-12" />
                Preparing…
              </span>
            ) : (
              "Download GST Report (CSV)"
            )}
          </button>
        </div>
        {error ? (
          <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="mt-3 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
            {message}
          </p>
        ) : null}
      </div>

      <section className="mt-6 rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4 text-sm text-primary-600/60">
        <h2 className="mb-2 text-sm font-semibold text-primary-400">Format</h2>
        <p>
          Each row is one settled invoice: Invoice No, GSTIN, Date, Taxable
          Value, CGST 2.5%, SGST 2.5% (5% food GST split). Taxable value is
          recomputed from order items.
        </p>
      </section>
    </main>
  );
}
