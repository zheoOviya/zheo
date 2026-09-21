"use client";

import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { searchAutocomplete, type SearchResult } from "@/lib/api";

const DEBOUNCE_MS = 350;

// D08 Search Autocomplete - debounced type-ahead against /api/v1/search/autocomplete.
export function SearchBar({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // Bounded local truth state: a valid empty result and a failed request must
  // never look the same. Both are cleared whenever a new request starts.
  const [emptyResult, setEmptyResult] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Short query is truthful idle, not an empty search: no request, no
      // status message.
      setResults([]);
      setLoading(false);
      setEmptyResult(false);
      setSearchError(false);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // Drop the previous query's results so they cannot be mistaken for this
    // query's results while it debounces/loads.
    setResults([]);
    setEmptyResult(false);
    setSearchError(false);
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const data = await searchAutocomplete(q, controller.signal);
        if (!controller.signal.aborted) {
          setResults(data);
          setEmptyResult(data.length === 0);
          setSearchError(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setEmptyResult(false);
          setSearchError(true);
        }
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
        <MagnifyingGlassIcon className="h-5 w-5" />
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
                  setEmptyResult(false);
                  setSearchError(false);
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
      {query.trim().length >= 2 && !loading && !searchError && emptyResult && (
        <p
          className="absolute z-10 mt-2 w-full rounded-2xl bg-white px-4 py-3 text-sm text-neutral-500 shadow-elevation-3 ring-1 ring-neutral-900/5 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-white/10"
          aria-live="polite"
        >
          No matching dishes or restaurants
        </p>
      )}
      {query.trim().length >= 2 && !loading && searchError && (
        <p
          className="absolute z-10 mt-2 w-full rounded-2xl bg-white px-4 py-3 text-sm text-red-600 shadow-elevation-3 ring-1 ring-neutral-900/5 dark:bg-neutral-900 dark:text-red-400 dark:ring-white/10"
          role="alert"
        >
          {"Couldn't search right now"}
        </p>
      )}
    </div>
  );
}
