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
      <m.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="py-16 text-center text-sm text-neutral-400 dark:text-neutral-500"
      >
        No restaurants available right now.
      </m.p>
    );
  }

  return (
    <section aria-label="Restaurants" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {restaurants.map((restaurant, index) => (
        <RestaurantCard key={restaurant.id} restaurant={restaurant} index={index} />
      ))}
    </section>
  );
}
