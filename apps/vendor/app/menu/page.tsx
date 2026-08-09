"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@snakzap/ui";
import { formatINR } from "@/lib/format";
import { RESTAURANT_ID } from "@/lib/constants";

interface MenuItem {
  id: string;
  name: string;
  price: number;
  dietary_tags: Record<string, boolean>;
  image_url: string | null;
  is_available: boolean;
}

const TAG_LABELS: Record<string, { label: string; className: string }> = {
  VEG: { label: "VEG", className: "border-green-500/40 text-green-400" },
  NON_VEG: { label: "NON VEG", className: "border-red-500/40 text-red-400" },
  JAIN: { label: "JAIN", className: "border-amber-500/40 text-amber-400" },
  HALAL: { label: "HALAL", className: "border-teal-500/40 text-teal-300" },
};

export default function MenuPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

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

  async function toggleAvailability(item: MenuItem) {
    try {
      const res = await fetch(`/api/vendor/menu/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_available: !item.is_available }),
      });
      const body = await res.json();
      if (body.success) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, is_available: body.data.is_available } : i,
          ),
        );
      }
    } catch {
      // ignore
    }
  }

  async function uploadPhoto(item: MenuItem, file: File) {
    setUploading(item.id);
    setError("");
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch(`/api/vendor/menu/${item.id}/upload-photo`, {
        method: "POST",
        body: form,
      });
      const body = await res.json();
      if (body.success) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, image_url: body.data.image_url } : i,
          ),
        );
      } else {
        setError(body.error?.message ?? "Upload failed");
      }
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(null);
      const input = fileInputs.current[item.id];
      if (input) input.value = "";
    }
  }

  return (
    <main className="mx-auto max-w-3xl py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">Menu Management</h1>
        <p className="mt-1 text-sm text-primary-600/50">
          Update prices, availability and food photos for your items
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-primary-600/30">
          No menu items yet
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-2xl bg-primary-900/30 border border-primary-500/10 p-4"
            >
              <div className="flex items-start gap-4">
                {uploading === item.id ? (
                  <Skeleton className="h-20 w-20 shrink-0 rounded-xl" />
                ) : item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={item.name}
                    className="h-20 w-20 shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-primary-500/30 bg-primary-900/40 text-xs text-primary-600/50">
                    No photo
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-neutral-200">{item.name}</p>
                    {Object.entries(TAG_LABELS)
                      .filter(([tag]) => item.dietary_tags[tag])
                      .map(([tag, info]) => (
                        <span
                          key={tag}
                          className={`rounded border px-1.5 py-0.5 text-2xs font-semibold ${info.className}`}
                        >
                          {info.label}
                        </span>
                      ))}
                  </div>
                  <p className="mt-1 text-sm text-primary-300">{formatINR(item.price)}</p>
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
                        if (file) void uploadPhoto(item, file);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputs.current[item.id]?.click()}
                      disabled={uploading === item.id}
                      className="rounded-full border border-primary-500/30 px-3 py-1.5 text-xs font-medium text-primary-300 hover:bg-primary-500/10 disabled:opacity-40"
                    >
                      {uploading === item.id ? "Uploading..." : "Upload Photo"}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleAvailability(item)}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        item.is_available
                          ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                          : "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                      }`}
                    >
                      {item.is_available ? "Available" : "Sold Out"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
