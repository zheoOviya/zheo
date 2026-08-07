"use client";

import { useCallback, useEffect, useState } from "react";
import TealSkeleton from "@/components/TealSkeleton";

interface MenuItem {
  id: string;
  name: string;
  price: number;
  description: string | null;
  is_available: boolean;
}

const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

export default function BulkMenuPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const fetchMenu = useCallback(async () => {
    try {
      const res = await fetch(`/api/vendor/menu?restaurant_id=${RESTAURANT_ID}`);
      const body = await res.json();
      if (body.success) setItems(body.data);
    } catch {
      setError("Failed to load menu");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMenu();
  }, [fetchMenu]);

  function update(
    id: string,
    patch: Partial<{ price: number; is_available: boolean; description: string }>,
  ) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function saveAll() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(
        `/api/vendor/menu/bulk?restaurant_id=${RESTAURANT_ID}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: items.map((item) => ({
              item_id: item.id,
              price: item.price,
              is_available: item.is_available,
              description: item.description ?? "",
            })),
          }),
        },
      );
      const body = await res.json();
      if (body.success) {
        setSuccess(`Saved ${body.data.length} menu items in one transaction.`);
      } else {
        setError(body.error?.message ?? "Save failed");
      }
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-400">Bulk Menu Edit</h1>
          <p className="mt-1 text-sm text-primary-600/60">
            Edit prices, availability and descriptions in one go. All changes
            are saved atomically.
          </p>
        </div>
        <button
          onClick={saveAll}
          disabled={saving || loading}
          className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-60"
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <TealSkeleton className="h-3 w-12" />
              Saving…
            </span>
          ) : (
            "Save All Changes"
          )}
        </button>
      </header>

      {error ? (
        <p className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mb-4 rounded-2xl border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-300">
          {success}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          <TealSkeleton className="h-12" />
          <TealSkeleton className="h-12" />
          <TealSkeleton className="h-12" />
          <TealSkeleton className="h-12" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-primary-500/15 bg-primary-900/30">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-primary-500/15 text-left text-xs uppercase tracking-wide text-primary-600/60">
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Price (INR)</th>
                <th className="px-4 py-3">Available</th>
                <th className="px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-primary-500/10 last:border-0"
                >
                  <td className="px-4 py-2 text-primary-300">{item.name}</td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      value={item.price}
                      min={1}
                      onChange={(e) =>
                        update(item.id, { price: Number(e.target.value) })
                      }
                      className="w-24 rounded-lg border border-primary-500/20 bg-primary-950/60 px-2 py-1 text-sm text-primary-100 focus:border-primary-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={item.is_available}
                      onChange={(e) =>
                        update(item.id, { is_available: e.target.checked })
                      }
                      className="h-4 w-4 accent-primary-500"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      value={item.description ?? ""}
                      maxLength={500}
                      onChange={(e) =>
                        update(item.id, { description: e.target.value })
                      }
                      className="w-full min-w-40 rounded-lg border border-primary-500/20 bg-primary-950/60 px-2 py-1 text-sm text-primary-100 focus:border-primary-500 focus:outline-none"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
