"use client";

import { useCallback, useEffect, useState } from "react";
import TealSkeleton from "@/components/TealSkeleton";
import { formatINR } from "@/lib/format";

interface Promotion {
  id: string;
  title: string;
  discount_type: "FLAT" | "PERCENTAGE";
  value: number;
  valid_until: string;
  is_active: boolean;
}

export default function PromotionsPage() {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [discountType, setDiscountType] = useState<"FLAT" | "PERCENTAGE">(
    "PERCENTAGE",
  );
  const [value, setValue] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchPromos = useCallback(async () => {
    try {
      const res = await fetch("/api/vendor/promotions");
      const body = await res.json();
      if (body.success) setPromos(body.data);
    } catch {
      setError("Failed to load promotions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPromos();
  }, [fetchPromos]);

  async function createPromo() {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/vendor/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          discount_type: discountType,
          value: Number(value),
          valid_until: validUntil,
        }),
      });
      const body = await res.json();
      if (body.success) {
        setSuccess("Promotion created");
        setTitle("");
        setValue("");
        setValidUntil("");
        fetchPromos();
      } else {
        setError(body.error?.message ?? "Failed to create promotion");
      }
    } catch {
      setError("Failed to create promotion");
    } finally {
      setSubmitting(false);
    }
  }

  function formatDiscount(p: Promotion): string {
    return p.discount_type === "PERCENTAGE"
      ? `${p.value}%`
      : formatINR(p.value);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">
          Promotions Builder
        </h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Create flat or percentage offers for your customers.
        </p>
      </header>

      <div className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
        <h2 className="mb-3 text-sm font-semibold text-primary-400">
          New promotion
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Monsoon Special"
              className="w-full rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 placeholder:text-primary-600/40 focus:border-primary-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">Type</span>
            <select
              value={discountType}
              onChange={(e) =>
                setDiscountType(e.target.value as "FLAT" | "PERCENTAGE")
              }
              className="w-full rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 focus:border-primary-500 focus:outline-none"
            >
              <option value="PERCENTAGE">Percentage</option>
              <option value="FLAT">Flat amount</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">
              {discountType === "PERCENTAGE" ? "Value (%)" : "Value (INR)"}
            </span>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={discountType === "PERCENTAGE" ? "15" : "50"}
              min={1}
              max={discountType === "PERCENTAGE" ? 100 : 100000}
              className="w-full rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 placeholder:text-primary-600/40 focus:border-primary-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-primary-600/60">
              Valid until
            </span>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="w-full rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 focus:border-primary-500 focus:outline-none"
            />
          </label>
        </div>
        <button
          onClick={createPromo}
          disabled={submitting || !title || !value || !validUntil}
          className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-400 disabled:opacity-60"
        >
          {submitting ? (
            <span className="inline-flex items-center gap-2">
              <TealSkeleton className="h-3 w-12" />
              Creating…
            </span>
          ) : (
            "Create Promotion"
          )}
        </button>
        {error ? (
          <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="mt-3 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-300">
            {success}
          </p>
        ) : null}
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-primary-400">
          Active promotions
        </h2>
        {loading ? (
          <div className="space-y-2">
            <TealSkeleton className="h-16" />
            <TealSkeleton className="h-16" />
          </div>
        ) : promos.length === 0 ? (
          <p className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4 text-sm text-primary-600/60">
            No active promotions yet. Create one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {promos.map((promo) => (
              <li
                key={promo.id}
                className="flex items-center justify-between rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4"
              >
                <div>
                  <p className="text-sm font-semibold text-primary-300">
                    {promo.title}
                  </p>
                  <p className="text-xs text-primary-600/60">
                    Valid until {promo.valid_until.slice(0, 10)}
                  </p>
                </div>
                <span className="rounded-full bg-amber-500/15 px-3 py-1 text-sm font-bold text-amber-300">
                  {formatDiscount(promo)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
