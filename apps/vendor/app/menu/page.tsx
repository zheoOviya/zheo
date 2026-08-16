"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { fetchMenu, updateMenuItem, uploadMenuPhoto, type VendorMenuItem } from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { formatINR } from "@/lib/format";
import { PageHeader, ErrorBanner, Spinner, EmptyPanel, SecondaryButton } from "@/components/ui";

const TAG_LABELS: Record<string, { label: string; className: string }> = {
  VEG: { label: "VEG", className: "border-emerald-500 text-emerald-600" },
  NON_VEG: { label: "NON VEG", className: "border-red-500 text-red-600" },
  JAIN: { label: "JAIN", className: "border-amber-500 text-amber-600" },
};

export default function MenuPage() {
  const [items, setItems] = useState<VendorMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
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

  async function toggleAvailability(item: VendorMenuItem) {
    if (!activeRestaurantId) return;
    setToggling(item.id);
    setError("");
    try {
      const updated = await updateMenuItem(
        item.id,
        {
          is_available: !item.is_available,
        },
        activeRestaurantId,
      );
      setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update item");
    } finally {
      setToggling(null);
    }
  }

  async function handlePhoto(item: VendorMenuItem, file: File) {
    if (!activeRestaurantId) return;
    setUploading(item.id);
    setError("");
    try {
      const result = await uploadMenuPhoto(item.id, file, activeRestaurantId);
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, image_url: result.image_url } : i)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
      const input = fileInputs.current[item.id];
      if (input) input.value = "";
    }
  }

  const availableCount = items.filter((i) => i.is_available).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Menu"
        subtitle={`${availableCount} of ${items.length} items available`}
        actions={
          <Link
            href="/menu/bulk"
            className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Bulk edit →
          </Link>
        }
      />

      <ErrorBanner message={error} />

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="h-8 w-8" />
        </div>
      ) : items.length === 0 ? (
        <EmptyPanel title="No menu items yet" description="Items will appear here once added." />
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const tags = Object.entries(TAG_LABELS).filter(
              ([tag]) => item.dietary_tags[tag] === true,
            );
            return (
              <div
                key={item.id}
                className={`rounded-xl border bg-white p-4 shadow-sm ${
                  item.is_available ? "border-slate-200" : "border-slate-200 opacity-70"
                }`}
              >
                <div className="flex items-start gap-4">
                  {uploading === item.id ? (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-slate-100">
                      <Spinner className="h-5 w-5" />
                    </div>
                  ) : item.image_url ? (
                    <Image
                      src={item.image_url}
                      alt={item.name}
                      width={80}
                      height={80}
                      className="h-20 w-20 shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-xs text-slate-400">
                      No photo
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-800">{item.name}</p>
                      {tags.map(([tag, info]) => (
                        <span
                          key={tag}
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${info.className}`}
                        >
                          {info.label}
                        </span>
                      ))}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 text-xs text-slate-400">{item.description}</p>
                    )}
                    <p className="mt-1 text-sm font-bold text-teal-700">{formatINR(item.price)}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        ref={(el) => {
                          fileInputs.current[item.id] = el;
                        }}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handlePhoto(item, file);
                        }}
                      />
                      <SecondaryButton
                        onClick={() => fileInputs.current[item.id]?.click()}
                        disabled={uploading === item.id}
                        className="min-h-[32px] px-3 py-1 text-xs"
                      >
                        {uploading === item.id ? "Uploading..." : "Upload Photo"}
                      </SecondaryButton>
                      <button
                        type="button"
                        onClick={() => toggleAvailability(item)}
                        disabled={toggling === item.id}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                          item.is_available
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                            : "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                        }`}
                      >
                        {toggling === item.id
                          ? "Updating..."
                          : item.is_available
                            ? "Available"
                            : "Sold Out"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
