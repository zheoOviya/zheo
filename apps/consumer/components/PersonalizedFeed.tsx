"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { m } from "framer-motion";
import { Badge } from "@snakzap/ui";
import { fetchPersonalizedHomepage, type PersonalizedHomepage } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

export function PersonalizedFeed() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [feed, setFeed] = useState<PersonalizedHomepage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPersonalizedHomepage(accessToken ?? undefined)
      .then((res) => {
        if (!cancelled) setFeed(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return (
    <section aria-label="Personalized For You" className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-primary-700 dark:text-primary-300">
          Personalized For You
        </h2>
        {feed && (
          <span className="text-xs text-neutral-400 dark:text-neutral-500">
            {feed.user_profile.strategy === "ml_weighted"
              ? "From your history"
              : "Fresh picks"}
          </span>
        )}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : feed === null ? (
        <div className="flex gap-4 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 w-52 shrink-0 animate-skeleton-teal rounded-xl bg-primary-100 dark:bg-primary-900/30"
            />
          ))}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {feed.personalized_restaurants.map((pick, i) => (
            <m.li
              key={pick.restaurant.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.25 }}
            >
              <Link
                href={`/restaurants/${pick.restaurant.id}`}
                className="block rounded-xl bg-white dark:bg-neutral-900 p-4 shadow-elevation-1 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3"
              >
                <p className="truncate font-semibold text-primary-700 dark:text-primary-300">
                  {pick.restaurant.name}
                </p>
                <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                  {pick.reason}
                </p>
              </Link>
            </m.li>
          ))}
          {feed.surprise_restaurant && (
            <m.li
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: feed.personalized_restaurants.length * 0.06, duration: 0.25 }}
            >
              <Link
                href={`/restaurants/${feed.surprise_restaurant.restaurant.id}`}
                className="block rounded-xl border-2 border-primary-500/40 bg-primary-500/5 dark:bg-primary-500/10 p-4 shadow-elevation-1 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3"
              >
                <Badge variant="gold" size="sm">Surprise</Badge>
                <p className="mt-2 truncate font-semibold text-primary-700 dark:text-primary-300">
                  {feed.surprise_restaurant.restaurant.name}
                </p>
                <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">
                  {feed.surprise_restaurant.reason}
                </p>
              </Link>
            </m.li>
          )}
        </ul>
      )}
    </section>
  );
}
