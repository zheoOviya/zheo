"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMenu, bulkUpdateMenu, type VendorMenuItem } from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { formatINR } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  ErrorBanner,
  Spinner,
  EmptyPanel,
  PrimaryButton,
} from "@/components/ui";

export default function BulkMenuPage() {
  const [items, setItems] = useState<VendorMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const { activeRestaurantId } = useActiveRestaurant();

  const load = useCallback(async () => {
    if (!activeRestaurantId) return;
    try {
      setItems(await fetchMenu(activeRestaurantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load menu");
    } finally {
      setLoading(false);
    }
  }, [activeRestaurantId]);

  useEffect(() => {
    load();
  }, [load]);

  function update(
    id: string,
    patch: Partial<{ price: number; is_available: boolean; description: string }>,
  ) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function handleSave() {
    if (!activeRestaurantId) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const updated = await bulkUpdateMenu(
        items.map((item) => ({
          item_id: item.id,
          price: item.price,
          is_available: item.is_available,
          description: item.description,
        })),
        activeRestaurantId,
      );
      setItems(updated);
      setSuccess(`Saved ${updated.length} menu items in one transaction.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const hasInvalidPrice = items.some((i) => !Number.isFinite(i.price) || i.price <= 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk Menu Edit"
        subtitle="Edit prices, availability and descriptions in one go. Changes are saved atomically."
        actions={
          <PrimaryButton onClick={handleSave} disabled={saving || loading || hasInvalidPrice}>
            {saving ? "Saving..." : "Save All Changes"}
          </PrimaryButton>
        }
      />

      <ErrorBanner message={error} />

      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="h-8 w-8" />
        </div>
      ) : items.length === 0 ? (
        <EmptyPanel title="No menu items" />
      ) : (
        <SectionCard>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-4 font-semibold">Item</th>
                  <th className="py-2 pr-4 font-semibold">Price</th>
                  <th className="py-2 pr-4 font-semibold">Available</th>
                  <th className="py-2 pr-4 font-semibold">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2 pr-4 font-medium text-slate-800">{item.name}</td>
                    <td className="py-2 pr-4">
                      <label className="sr-only" htmlFor={`price-${item.id}`}>
                        Price for {item.name}
                      </label>
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400">₹</span>
                        <input
                          id={`price-${item.id}`}
                          type="number"
                          value={item.price}
                          min={1}
                          onChange={(e) => update(item.id, { price: Number(e.target.value) })}
                          className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <label className="sr-only" htmlFor={`avail-${item.id}`}>
                        Available toggle for {item.name}
                      </label>
                      <input
                        id={`avail-${item.id}`}
                        type="checkbox"
                        checked={item.is_available}
                        onChange={(e) => update(item.id, { is_available: e.target.checked })}
                        className="h-4 w-4 accent-teal-600"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <label className="sr-only" htmlFor={`desc-${item.id}`}>
                        Description for {item.name}
                      </label>
                      <input
                        id={`desc-${item.id}`}
                        type="text"
                        value={item.description ?? ""}
                        maxLength={500}
                        onChange={(e) => update(item.id, { description: e.target.value })}
                        className="w-full min-w-40 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Reference current price: {items[0] ? formatINR(items[0].price) : "—"}
          </p>
        </SectionCard>
      )}
    </div>
  );
}
