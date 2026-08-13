"use client";

import { m } from "framer-motion";
import { RestaurantCard } from "./RestaurantCard";
import type { Restaurant } from "@/lib/api";

interface RestaurantGridProps {
  restaurants: Restaurant[];
}

export function RestaurantGrid({ restaurants }: RestaurantGridProps) {
  if (restaurants.length === 0) {
    return (
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="surface-card px-6 py-14 text-center"
      >
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
          No restaurants available right now
        </p>
        <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          Check back soon — new places are joining SnakZap every week.
        </p>
      </m.div>
    );
  }

  return (
    <section
      aria-label="Restaurants"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {restaurants.map((restaurant, index) => (
        <RestaurantCard key={restaurant.id} restaurant={restaurant} index={index} />
      ))}
    </section>
  );
}
