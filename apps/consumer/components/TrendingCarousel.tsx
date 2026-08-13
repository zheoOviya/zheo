"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { m } from "framer-motion";
import { Badge } from "@snakzap/ui";
import { fetchTrending, type TrendingDish } from "@/lib/api";
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
      <section aria-label="Trending Now" className="mt-8">
        <div className="section-head">
          <div>
            <p className="section-eyebrow">Popular</p>
            <h2 className="section-title">Trending Now</h2>
          </div>
        </div>
        <p className="surface-card p-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      </section>
    );
  }

  return (
    <section aria-label="Trending Now" className="mt-8">
      <div className="section-head">
        <div>
          <p className="section-eyebrow">Popular</p>
          <h2 className="section-title">Trending Now</h2>
        </div>
        {dishes && dishes.length > 0 && (
          <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">
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
        <m.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="rounded-xl bg-white dark:bg-neutral-900 p-4 text-sm text-neutral-400 dark:text-neutral-500 shadow-elevation-1"
        >
          No trending dishes in the last hour yet. Order something tasty!
        </m.p>
      ) : (
        <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 scrollbar-hide">
          {dishes.map((dish, index) => {
            const rank = index as 0 | 1 | 2;
            const variant = rank < 3 ? rankVariants[rank] : "default";
            const label = rank < 3 ? rankLabels[rank] : `#${index + 1}`;

            return (
              <m.li
                key={`${dish.restaurant_id}-${dish.menu_item_id}`}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.08, duration: 0.3 }}
                className="w-56 shrink-0 snap-start"
              >
                <Link
                  href={`/restaurants/${dish.restaurant_id}`}
                  className="group block overflow-hidden rounded-3xl bg-white shadow-elevation-1 ring-1 ring-neutral-900/5 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3 dark:bg-neutral-900 dark:ring-white/5"
                >
                  <div className="relative h-28 w-full overflow-hidden bg-primary-100 dark:bg-primary-900/30">
                    <Image
                      src={`https://picsum.photos/seed/${dish.menu_item_id}/400/220`}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 224px, 224px"
                      loading="lazy"
                      className="img-zoom object-cover"
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent"
                    />
                    <span className="absolute left-2 top-2">
                      <Badge variant={variant} size="sm">
                        {label}
                      </Badge>
                    </span>
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-2xs font-bold text-white backdrop-blur">
                      {dish.quantity_sold} sold
                    </span>
                  </div>
                  <div className="p-3">
                    <h3 className="line-clamp-1 text-sm font-bold tracking-tight text-neutral-900 dark:text-white">
                      {dish.name}
                    </h3>
                    <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500">
                      {dish.restaurant_name}
                    </p>
                    <p className="mt-1.5 text-sm font-extrabold text-primary-700 dark:text-primary-300">
                      {formatINR(dish.price)}
                    </p>
                  </div>
                </Link>
              </m.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
