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
    if (result.type === "restaurant") {
      router.push(`/restaurants/${result.id}`);
      return;
    }

    if (!result.restaurant_id) {
      return;
    }

    router.push(`/restaurants/${result.restaurant_id}`);
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
            {dishResults.map((item) => {
              const content = (
                <>
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    {item.name}
                  </span>
                  <span className="text-sm font-bold text-primary-600 dark:text-primary-400">
                    {formatINR(item.price)}
                  </span>
                </>
              );

              return item.restaurant_id ? (
                <li key={item.id}>
                  <Link
                    href={`/restaurants/${item.restaurant_id}`}
                    className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-surface-light dark:hover:bg-neutral-800"
                  >
                    {content}
                  </Link>
                </li>
              ) : (
                <li key={item.id}>
                  <div className="flex items-center justify-between px-4 py-3">{content}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
