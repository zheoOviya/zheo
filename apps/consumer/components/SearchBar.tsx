"use client";

import { useEffect, useRef, useState } from "react";
import { searchAutocomplete, type SearchResult } from "@/lib/api";

const DEBOUNCE_MS = 350;

// D08 Search Autocomplete - debounced type-ahead against /api/v1/search/autocomplete.
export function SearchBar({ onSelect }: { onSelect: (result: SearchResult) => void }) {
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
      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400">
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
          />
        </svg>
      </span>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search dishes or restaurants"
        aria-label="Search dishes or restaurants"
        className="w-full rounded-2xl border-0 bg-white py-3 pl-11 pr-10 text-sm shadow-elevation-1 ring-1 ring-neutral-900/5 outline-none transition-all placeholder:text-neutral-400 focus:ring-2 focus:ring-primary-500 dark:bg-neutral-900 dark:ring-white/10"
      />
      {loading && query.trim().length >= 2 && (
        <div
          aria-hidden
          className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-skeleton-teal rounded-full bg-primary-500/40"
        />
      )}
      {results.length > 0 && (
        <ul className="absolute z-10 mt-2 w-full overflow-hidden rounded-2xl bg-white shadow-elevation-3 ring-1 ring-neutral-900/5 dark:bg-neutral-900 dark:ring-white/10">
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`}>
              <button
                type="button"
                onClick={() => {
                  onSelect(result);
                  setResults([]);
                }}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-neutral-700 hover:bg-surface-light dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span className="truncate">{result.name}</span>
                <span className="ml-2 shrink-0 rounded-full bg-primary-500/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-primary-600 dark:text-primary-400">
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
