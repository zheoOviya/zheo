"use client";

import { useRef, useState } from "react";
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
  const [error, setError] = useState(false);
  // Latest successful request yielded zero matches while a filter is active.
  // This is a truthful empty result, distinct from a cleared filter or a
  // failure, and only the latest request may mutate it.
  const [emptyResult, setEmptyResult] = useState(false);
  // Monotonic request version: only the latest toggle may apply results,
  // errors, or loading transitions; older in-flight responses are ignored.
  const requestVersionRef = useRef(0);

  async function toggle(tag: string) {
    const next = selected.includes(tag)
      ? selected.filter((t) => t !== tag)
      : [...selected, tag];
    setSelected(next);

    const version = ++requestVersionRef.current;

    if (next.length === 0) {
      // Clearing the filter invalidates any in-flight request and replaces the
      // previous truthful results with an empty list (no network request).
      setLoading(false);
      setError(false);
      setEmptyResult(false);
      onResults([]);
      return;
    }

    setLoading(true);
    setError(false);
    setEmptyResult(false);
    try {
      const items = await filterMenuByDietary([...next]);
      if (version !== requestVersionRef.current) return;
      onResults(items);
      setError(false);
      setEmptyResult(items.length === 0);
    } catch {
      if (version !== requestVersionRef.current) return;
      // Keep the previous truthful results instead of fabricating an empty
      // filter result; surface a bounded local error.
      setError(true);
    } finally {
      if (version === requestVersionRef.current) setLoading(false);
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
            className={`min-h-touch rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
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
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400" role="alert">
          {"Couldn't update filters"}
        </span>
      )}
      {selected.length > 0 && !loading && !error && emptyResult && (
        <span
          className="text-xs text-neutral-500 dark:text-neutral-400"
          aria-live="polite"
        >
          No matching dishes
        </span>
      )}
    </div>
  );
}
