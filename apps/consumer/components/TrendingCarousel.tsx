"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchTrending,
  type TrendingDish,
} from "@/lib/api";
import { formatINR } from "@/lib/pricing";

// Trending Now (D17): the top dishes in the last 60 minutes within 5 km,
// fetched live from /discovery/trending and rendered as a snap-scrolling
// carousel with teal rank badges.

const SKELETON_ITEMS = [0, 1, 2, 3];

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
      <section aria-label="Trending Now" className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-primary-700">
          Trending Now
        </h2>
        <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</p>
      </section>
    );
  }

  return (
    <section aria-label="Trending Now" className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-primary-700">
          Trending Now
        </h2>
        {dishes && dishes.length > 0 && (
          <span className="text-xs text-neutral-400">
            Last 60 minutes &middot; within 5 km
          </span>
        )}
      </div>

      {dishes === null ? (
        <div className="flex gap-4 overflow-hidden">
          {SKELETON_ITEMS.map((i) => (
            <div
              key={i}
              className="h-36 w-52 shrink-0 animate-skeleton-teal rounded-xl bg-primary-100"
            />
          ))}
        </div>
      ) : dishes.length === 0 ? (
        <p className="rounded-xl bg-white p-4 text-sm text-neutral-400 shadow-sm">
          No trending dishes in the last hour yet. Order something tasty!
        </p>
      ) : (
        <ul className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
          {dishes.map((dish, index) => (
            <li
              key={`${dish.restaurant_id}-${dish.menu_item_id}`}
              className="w-52 shrink-0 snap-start"
            >
              <Link
                href={`/restaurants/${dish.restaurant_id}`}
                className="block rounded-xl bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="rounded-md bg-primary-500 px-2 py-0.5 text-xs font-bold text-white">
                    #{index + 1}
                  </span>
                  <span className="text-xs font-semibold text-primary-600">
                    {dish.quantity_sold} sold
                  </span>
                </div>
                <h3 className="mt-3 truncate font-semibold text-neutral-700">
                  {dish.name}
                </h3>
                <p className="truncate text-xs text-neutral-400">
                  {dish.restaurant_name}
                </p>
                <p className="mt-2 text-sm font-bold text-primary-700">
                  {formatINR(dish.price)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
