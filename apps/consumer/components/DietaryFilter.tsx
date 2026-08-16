"use client";

import { useState } from "react";
import { filterMenuByDietary, type MenuItem } from "@/lib/api";

const DIETARY_TAGS = ["VEG", "JAIN"] as const;

// D05 Dietary Filter - chip row filtering menu items via the GIN-indexed
// /api/v1/menu-items/filter endpoint. Multi-select applies containment (AND).
export function DietaryFilter({
  onResults,
}: {
  onResults: (items: MenuItem[]) => void;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);

  async function toggle(tag: string) {
    const next = selected.includes(tag)
      ? selected.filter((t) => t !== tag)
      : [...selected, tag];
    setSelected(next);
    setLoading(true);
    try {
      const items =
        next.length > 0 ? await filterMenuByDietary([...next]) : [];
      onResults(items);
    } catch {
      onResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Dietary filters"
    >
      {DIETARY_TAGS.map((tag) => {
        const active = selected.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(tag)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-primary-500 text-white"
                : "bg-white text-primary-700 ring-1 ring-primary-500/30 hover:bg-primary-500/10"
            }`}
          >
            {tag}
          </button>
        );
      })}
      {loading && (
        <span className="text-xs text-primary-500" aria-live="polite">
          Filtering…
        </span>
      )}
    </div>
  );
}
