"use client";

import { useEffect, useState } from "react";
import TealSkeleton from "@/components/TealSkeleton";
import { formatINR } from "@/lib/format";
import { authedFetch } from "@/lib/cateringAuth";

interface ChainSummary {
  id: string;
  name: string;
  outlets: { restaurant_id: string; name: string }[];
}

interface MenuItem {
  id: string;
  name: string;
  price: number;
}

interface LineItem {
  menu_item_id: string;
  quantity: number;
  unit_price?: number;
  description?: string;
}

interface ConfirmedOrder {
  id: string;
  status: string;
  is_catering: boolean;
  headcount: number;
  total_amount: number;
  event_date: string;
  items: { name: string; quantity: number; base_price: number }[];
}

const emptyLine = (): LineItem => ({
  menu_item_id: "",
  quantity: 100,
});

export default function CateringPage() {
  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [eventDate, setEventDate] = useState("");
  const [headcount, setHeadcount] = useState(100);
  const [budget, setBudget] = useState("");
  const [instructions, setInstructions] = useState("");
  const [lines, setLines] = useState<LineItem[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<ConfirmedOrder | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch("/api/vendor/chains");
        const body = await res.json();
        if (body.success) {
          setChains(body.data);
          const first = body.data[0]?.outlets?.[0];
          if (first) setRestaurantId(first.restaurant_id);
        } else {
          setError(body.error?.message ?? "Failed to load chains");
        }
      } catch {
        setError("Failed to load chains");
      }
    })();
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    setMenu([]);
    (async () => {
      try {
        const res = await fetch(
          `/api/vendor/menu?restaurant_id=${restaurantId}`,
        );
        const body = await res.json();
        if (body.success) {
          setMenu(body.data);
          setLines((prev) =>
            prev.map((l) => ({
              ...l,
              menu_item_id: l.menu_item_id || body.data[0]?.id || "",
            })),
          );
        }
      } catch {
        // menu load failure is non-fatal; items stay empty
      }
    })();
  }, [restaurantId]);

  function updateLine(index: number, patch: Partial<LineItem>) {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    );
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
      const res = await authedFetch("/api/v1/orders/catering", {
        method: "POST",
        body: JSON.stringify({
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
        }),
      });
      const body = await res.json();
      if (body.success) {
        setConfirmed(body.data);
      } else {
        setError(body.error?.message ?? "Catering request failed");
      }
    } catch {
      setError("Catering request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const estimatedTotal = lines.reduce(
    (sum, l) =>
      sum +
      (l.menu_item_id ? l.quantity * (l.unit_price ?? 0) : 0),
    0,
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">
          B2B Catering Request
        </h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Bulk corporate and event orders. Minimum 50 guests, advance
          scheduling with custom bulk pricing.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {confirmed ? (
        <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-5">
          <h2 className="text-lg font-bold text-green-400">
            Catering order confirmed
          </h2>
          <p className="mt-1 text-sm text-green-200/80">
            Order {confirmed.id.slice(0, 8)} &middot; status{" "}
            <span className="font-semibold">{confirmed.status}</span>
            &middot; flagged is_catering
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-primary-600/60">Headcount</dt>
              <dd className="font-semibold text-primary-300">
                {confirmed.headcount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-primary-600/60">Total</dt>
              <dd className="font-semibold text-primary-300">
                {formatINR(confirmed.total_amount)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-primary-600/60">Event date</dt>
              <dd className="font-semibold text-primary-300">
                {new Date(confirmed.event_date).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-primary-600/60">Lines</dt>
              <dd className="font-semibold text-primary-300">
                {confirmed.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => {
              setConfirmed(null);
              setLines([emptyLine()]);
              setInstructions("");
              setBudget("");
            }}
            className="mt-5 rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover active:scale-95 transition-transform"
          >
            New catering request
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <section className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <h2 className="mb-3 text-sm font-semibold text-primary-400">
              Event details
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-primary-600/60">
                  Outlet / restaurant
                </span>
                <select
                  value={restaurantId}
                  onChange={(e) => setRestaurantId(e.target.value)}
                  className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
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
                <span className="mb-1 block text-xs text-primary-600/60">
                  Event date &amp; time
                </span>
                <input
                  type="datetime-local"
                  value={eventDate}
                  onChange={(e) => setEventDate(e.target.value)}
                  className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-primary-600/60">
                  Headcount (min 50)
                </span>
                <input
                  type="number"
                  min={50}
                  value={headcount}
                  onChange={(e) => setHeadcount(Number(e.target.value))}
                  className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-primary-600/60">
                  Budget (INR, optional)
                </span>
                <input
                  type="number"
                  min={0}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="e.g. 50000"
                  className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 placeholder-primary-600/30 outline-none focus:border-primary-500"
                />
              </label>
              <label className="block col-span-2">
                <span className="mb-1 block text-xs text-primary-600/60">
                  Special instructions
                </span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={2}
                  placeholder="Setup time, buffet layout, dietary notes..."
                  className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 placeholder-primary-600/30 outline-none focus:border-primary-500"
                />
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <h2 className="mb-3 text-sm font-semibold text-primary-400">
              Bulk menu lines
            </h2>
            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-12 items-end gap-2">
                  <label className="col-span-4 block">
                    <span className="mb-1 block text-xs text-primary-600/60">
                      Menu item
                    </span>
                    {menu.length === 0 ? (
                      <TealSkeleton className="h-9 w-full" />
                    ) : (
                      <select
                        value={line.menu_item_id}
                        onChange={(e) =>
                          updateLine(index, { menu_item_id: e.target.value })
                        }
                        className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
                      >
                        {menu.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} ({formatINR(m.price)})
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                  <label className="col-span-2 block">
                    <span className="mb-1 block text-xs text-primary-600/60">
                      Qty
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(index, {
                          quantity: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-primary-500"
                    />
                  </label>
                  <label className="col-span-3 block">
                    <span className="mb-1 block text-xs text-primary-600/60">
                      Unit price (override)
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={line.unit_price ?? ""}
                      onChange={(e) =>
                        updateLine(index, {
                          unit_price: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="catalog price"
                      className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 placeholder-primary-600/30 outline-none focus:border-primary-500"
                    />
                  </label>
                  <div className="col-span-2 flex gap-2">
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setLines((prev) =>
                            prev.filter((_, i) => i !== index),
                          )
                        }
                        className="w-full rounded-full border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="mt-3 rounded-full border border-primary-500/30 bg-primary-500/10 px-4 py-2 text-sm font-medium text-primary-300 hover:bg-primary-500/20"
            >
              + Add line
            </button>
            <p className="mt-3 text-xs text-primary-600/60">
              Estimated subtotal (prices before GST):{" "}
              <span className="font-semibold text-primary-300">
                {formatINR(estimatedTotal)}
              </span>
            </p>
          </section>

          <button
            type="button"
            onClick={submit}
            disabled={
              submitting ||
              !restaurantId ||
              !eventDate ||
              headcount < 50
            }
            className="w-full rounded-full bg-primary-500 px-5 py-3 text-sm font-bold text-white hover:bg-primary-hover active:scale-95 transition-transform disabled:opacity-30"
          >
            {submitting ? "Submitting..." : "Request catering"}
          </button>
        </div>
      )}
    </main>
  );
}
