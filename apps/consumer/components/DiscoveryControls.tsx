"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MenuItem, SearchResult } from "@/lib/api";
import { formatINR } from "@/lib/pricing";
import { SearchBar } from "./SearchBar";
import { DietaryFilter } from "./DietaryFilter";

// Client island: owns interactive discovery state (search + dietary filter)
// while the RestaurantGrid below remains a server component.
// Selecting a result navigates to that restaurant's menu page.
export function DiscoveryControls() {
  const router = useRouter();
  const [dishResults, setDishResults] = useState<MenuItem[]>([]);

  function navigateToResult(result: SearchResult) {
    const target =
      result.type === "restaurant"
        ? `/restaurants/${result.id}`
        : result.restaurant_id
          ? `/restaurants/${result.restaurant_id}`
          : "/";
    router.push(target);
  }

  return (
    <div className="space-y-4">
      <SearchBar
        onSelect={(result) => {
          setDishResults([]);
          navigateToResult(result);
        }}
      />
      <DietaryFilter onResults={setDishResults} />

      {dishResults.length > 0 && (
        <section aria-label="Filtered dishes" className="space-y-2">
          <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
            Matching dishes
          </h3>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-elevation-1 ring-1 ring-neutral-900/5 dark:divide-neutral-800 dark:bg-neutral-900 dark:ring-white/5">
            {dishResults.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.restaurant_id ? `/restaurants/${item.restaurant_id}` : "/"}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-surface-light dark:hover:bg-neutral-800"
                >
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    {item.name}
                  </span>
                  <span className="text-sm font-bold text-primary-600 dark:text-primary-400">
                    {formatINR(item.price)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
