"use client";

import { useEffect, useState } from "react";
import {
  fetchChains,
  fetchMenu,
  placeCateringOrder,
  type Chain,
  type VendorMenuItem,
  type CateringOrderResult,
} from "@/lib/api";
import { formatINR, formatDateTime, shortOrderId } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  Spinner,
} from "@/components/ui";

interface LineItem {
  menu_item_id: string;
  quantity: number;
  unit_price?: number;
  description?: string;
}

const emptyLine = (): LineItem => ({ menu_item_id: "", quantity: 100 });

export default function CateringPage() {
  const [chains, setChains] = useState<Chain[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [menu, setMenu] = useState<VendorMenuItem[]>([]);
  const [eventDate, setEventDate] = useState("");
  const [headcount, setHeadcount] = useState(100);
  const [budget, setBudget] = useState("");
  const [instructions, setInstructions] = useState("");
  const [lines, setLines] = useState<LineItem[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<CateringOrderResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchChains();
        setChains(data);
        const first = data[0]?.outlets?.[0];
        if (first) setRestaurantId(first.restaurant_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load chains");
      }
    })();
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    setMenu([]);
    fetchMenu(restaurantId)
      .then((data) => {
        setMenu(data);
        setLines((prev) =>
          prev.map((l) => ({
            ...l,
            menu_item_id: l.menu_item_id || data[0]?.id || "",
          })),
        );
      })
      .catch(() => {
        // menu load failure is non-fatal; items stay empty
      });
  }, [restaurantId]);

  function updateLine(index: number, patch: Partial<LineItem>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setError("");
    setConfirmed(null);
    if (lines.some((l) => !l.menu_item_id)) {
      setError("Every line item needs a menu item selected");
      return;
    }
    setSubmitting(true);
    try {
      const result = await placeCateringOrder({
        restaurant_id: restaurantId,
        event_date: new Date(eventDate).toISOString(),
        headcount,
        budget: budget ? Number(budget) : undefined,
        special_instructions: instructions || undefined,
        items: lines.map((l) => ({
          menu_item_id: l.menu_item_id,
          quantity: l.quantity,
          unit_price: l.unit_price ?? undefined,
          description: l.description || undefined,
        })),
      });
      setConfirmed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Catering request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const estimatedTotal = lines.reduce(
    (sum, l) => sum + (l.menu_item_id ? l.quantity * (l.unit_price ?? 0) : 0),
    0,
  );

  if (confirmed) {
    return (
      <div className="space-y-6">
        <PageHeader title="B2B Catering" subtitle="Bulk corporate and event orders" />
        <SectionCard title="Catering order confirmed">
          <p className="text-sm text-slate-600">
            Order <span className="font-mono font-semibold">#{shortOrderId(confirmed.id)}</span> ·
            status <span className="font-semibold text-emerald-600">{confirmed.status}</span>
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-xs text-slate-500">Headcount</dt>
              <dd className="font-semibold text-slate-800">{confirmed.headcount}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-xs text-slate-500">Total</dt>
              <dd className="font-semibold text-slate-800">{formatINR(confirmed.total_amount)}</dd>
            </div>
            <div className="col-span-2 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-xs text-slate-500">Event date</dt>
              <dd className="font-semibold text-slate-800">
                {formatDateTime(confirmed.event_date)}
              </dd>
            </div>
            <div className="col-span-2 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-xs text-slate-500">Lines</dt>
              <dd className="text-slate-700">
                {confirmed.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
              </dd>
            </div>
          </dl>
          <div className="mt-5">
            <SecondaryButton
              onClick={() => {
                setConfirmed(null);
                setLines([emptyLine()]);
                setInstructions("");
                setBudget("");
              }}
            >
              New catering request
            </SecondaryButton>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="B2B Catering"
        subtitle="Bulk corporate and event orders. Minimum 50 guests, advance scheduling with custom bulk pricing."
      />

      <ErrorBanner message={error} />

      <SectionCard title="Event details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">Outlet</span>
            <select
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            >
              {chains.flatMap((c) =>
                c.outlets.map((o) => (
                  <option key={o.restaurant_id} value={o.restaurant_id}>
                    {o.name}
                  </option>
                )),
              )}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Event date &amp; time
            </span>
            <input
              type="datetime-local"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Headcount (min 50)
            </span>
            <input
              type="number"
              min={50}
              value={headcount}
              onChange={(e) => setHeadcount(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Budget (INR, optional)
            </span>
            <input
              type="number"
              min={0}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="e.g. 50000"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Special instructions
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
              placeholder="Setup time, buffet layout, dietary notes..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Bulk menu lines" subtitle="Pick items and quantities for the event">
        {menu.length === 0 ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-12 items-end gap-2">
                  <label className="col-span-5 block sm:col-span-4">
                    <span className="mb-1 block text-xs font-medium text-slate-500">Menu item</span>
                    <select
                      value={line.menu_item_id}
                      onChange={(e) => updateLine(index, { menu_item_id: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    >
                      {menu.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({formatINR(m.price)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-3 block sm:col-span-2">
                    <span className="mb-1 block text-xs font-medium text-slate-500">Qty</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={line.quantity}
                      onChange={(e) => updateLine(index, { quantity: Number(e.target.value) })}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    />
                  </label>
                  <label className="col-span-4 block">
                    <span className="mb-1 block text-xs font-medium text-slate-500">
                      Unit price (override)
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={line.unit_price ?? ""}
                      onChange={(e) =>
                        updateLine(index, {
                          unit_price: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      placeholder="catalog price"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    />
                  </label>
                  <div className="col-span-12 flex justify-end sm:col-span-2">
                    {lines.length > 1 && (
                      <SecondaryButton
                        onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                        className="min-h-[38px] w-full border-red-200 text-red-600 hover:bg-red-50 sm:w-auto"
                      >
                        Remove
                      </SecondaryButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <SecondaryButton onClick={() => setLines((prev) => [...prev, emptyLine()])}>
                + Add line
              </SecondaryButton>
              <p className="text-xs text-slate-400">
                Estimated subtotal (before GST):{" "}
                <span className="font-semibold text-teal-700">{formatINR(estimatedTotal)}</span>
              </p>
            </div>
          </>
        )}
      </SectionCard>

      <PrimaryButton
        onClick={submit}
        disabled={submitting || !restaurantId || !eventDate || headcount < 50}
        className="w-full"
      >
        {submitting ? "Submitting..." : "Request Catering"}
      </PrimaryButton>
    </div>
  );
}
