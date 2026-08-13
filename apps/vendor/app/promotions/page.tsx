"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchPromotions, createPromotion, type Promotion } from "@/lib/api";
import { formatINR, formatDate } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  ErrorBanner,
  EmptyPanel,
  Spinner,
  PrimaryButton,
} from "@/components/ui";

export default function PromotionsPage() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [discountType, setDiscountType] = useState<"FLAT" | "PERCENTAGE">("PERCENTAGE");
  const [value, setValue] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    try {
      setPromos(await fetchPromotions());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load promotions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await createPromotion({
        title,
        discount_type: discountType,
        value: Number(value),
        valid_until: validUntil,
      });
      setSuccess("Promotion created");
      setTitle("");
      setValue("");
      setValidUntil("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create promotion");
    } finally {
      setSubmitting(false);
    }
  }

  function formatDiscount(p: Promotion): string {
    return p.discount_type === "PERCENTAGE" ? `${p.value}%` : formatINR(p.value);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Promotions" subtitle="Create offers for your customers" />

      <ErrorBanner message={error} />
      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      <SectionCard title="New promotion">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Monsoon Special"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Type</span>
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as "FLAT" | "PERCENTAGE")}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            >
              <option value="PERCENTAGE">Percentage</option>
              <option value="FLAT">Flat amount</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              {discountType === "PERCENTAGE" ? "Value (%)" : "Value (INR)"}
            </span>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={discountType === "PERCENTAGE" ? "15" : "50"}
              min={1}
              max={discountType === "PERCENTAGE" ? 100 : 100000}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Valid until</span>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
        </div>
        <div className="mt-4">
          <PrimaryButton
            onClick={handleCreate}
            disabled={submitting || !title || !value || !validUntil}
          >
            {submitting ? "Creating..." : "Create Promotion"}
          </PrimaryButton>
        </div>
      </SectionCard>

      <SectionCard title="Active promotions" subtitle="Live offers visible to customers">
        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : promos.length === 0 ? (
          <EmptyPanel title="No active promotions" description="Create one above to get started." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {promos.map((promo) => (
              <li key={promo.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">{promo.title}</p>
                  <p className="text-xs text-slate-400">
                    Valid until {formatDate(promo.valid_until)}
                  </p>
                </div>
                <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-bold text-amber-700 ring-1 ring-inset ring-amber-200">
                  {formatDiscount(promo)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
