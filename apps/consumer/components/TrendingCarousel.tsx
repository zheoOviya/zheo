"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Badge } from "@snakzap/ui";
import {
  fetchTrending,
  type TrendingDish,
} from "@/lib/api";
import { formatINR } from "@/lib/pricing";

const SKELETON_ITEMS = [0, 1, 2, 3];

const rankVariants = {
  0: "gold" as const,
  1: "silver" as const,
  2: "bronze" as const,
};

const rankLabels = {
  0: "#1",
  1: "#2",
  2: "#3",
};

export function TrendingCarousel() {
  const [dishes, setDishes] = useState<TrendingDish[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTrending({ radius_km: 5, minutes: 60 })
      .then((res) => {
        if (!cancelled) setDishes(res.trending);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <section aria-label="Trending Now" className="mt-6">
        <h2 className="mb-3 text-lg font-bold text-primary-700 dark:text-primary-300">
          Trending Now
        </h2>
        <p className="rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Trending Now" className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-primary-700 dark:text-primary-300">
          Trending Now
        </h2>
        {dishes && dishes.length > 0 && (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            Last 60 min &middot; 5 km
          </span>
        )}
      </div>

      {dishes === null ? (
        <div className="flex gap-3 overflow-hidden">
          {SKELETON_ITEMS.map((i) => (
            <div
              key={i}
              className="h-36 w-52 shrink-0 animate-skeleton-teal rounded-xl bg-primary-100 dark:bg-primary-900/30"
            />
          ))}
        </div>
      ) : dishes.length === 0 ? (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-xl bg-white dark:bg-neutral-900 p-4 text-sm text-neutral-400 dark:text-neutral-500 shadow-elevation-1"
        >
          No trending dishes in the last hour yet. Order something tasty!
        </motion.p>
      ) : (
        <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 scrollbar-hide">
          {dishes.map((dish, index) => {
            const rank = index as 0 | 1 | 2;
            const variant = rank < 3 ? rankVariants[rank] : "default";
            const label = rank < 3 ? rankLabels[rank] : `#${index + 1}`;

            return (
              <motion.li
                key={`${dish.restaurant_id}-${dish.menu_item_id}`}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.08, duration: 0.3 }}
                className="w-52 shrink-0 snap-start"
              >
                <Link
                  href={`/restaurants/${dish.restaurant_id}`}
                  className="block rounded-xl bg-white dark:bg-neutral-900 p-4 shadow-elevation-1 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3"
                >
                  <div className="flex items-center justify-between">
                    <Badge variant={variant} size="sm">
                      {label}
                    </Badge>
                    <span className="text-2xs font-semibold text-primary-600 dark:text-primary-400">
                      {dish.quantity_sold} sold
                    </span>
                  </div>
                  <h3 className="mt-3 truncate font-semibold text-neutral-700 dark:text-neutral-200">
                    {dish.name}
                  </h3>
                  <p className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                    {dish.restaurant_name}
                  </p>
                  <p className="mt-2 text-sm font-bold text-primary-700 dark:text-primary-300">
                    {formatINR(dish.price)}
                  </p>
                </Link>
              </motion.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
