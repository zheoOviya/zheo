"use client";

import { useEffect, useRef, useState } from "react";
import { searchAutocomplete, type SearchResult } from "@/lib/api";

const DEBOUNCE_MS = 350;

// D08 Search Autocomplete - debounced type-ahead against /api/v1/search/autocomplete.
export function SearchBar({
  onSelect,
}: {
  onSelect: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const data = await searchAutocomplete(q, controller.signal);
        if (!controller.signal.aborted) setResults(data);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div className="relative">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search dishes or restaurants"
        aria-label="Search dishes or restaurants"
        className="w-full rounded-full border-0 bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-primary-500/20 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-primary-500"
      />
      {loading && query.trim().length >= 2 && (
        <div
          aria-hidden
          className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-skeleton-teal rounded-full bg-primary-500/40"
        />
      )}
      {results.length > 0 && (
        <ul className="absolute z-10 mt-2 w-full overflow-hidden rounded-xl bg-white shadow-lg">
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`}>
              <button
                type="button"
                onClick={() => {
                  onSelect(result);
                  setResults([]);
                }}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-neutral-700 hover:bg-surface-light"
              >
                <span className="truncate">{result.name}</span>
                <span className="ml-2 shrink-0 text-xs text-primary-500">
                  {result.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
