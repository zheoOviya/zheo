"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { m } from "framer-motion";
import { Badge } from "@snakzap/ui";
import { BrandImage } from "@/components/BrandImage";
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
    <section aria-label="Personalized For You" className="mt-8">
      <div className="section-head">
        <div>
          <p className="section-eyebrow">Curated</p>
          <h2 className="section-title">Personalized For You</h2>
        </div>
        {feed && (
          <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">
            {feed.user_profile.strategy === "ml_weighted" ? "From your history" : "Fresh picks"}
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
                className="group block overflow-hidden rounded-2xl bg-white shadow-elevation-1 ring-1 ring-neutral-900/5 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3 dark:bg-neutral-900 dark:ring-white/5"
              >
                <div className="relative h-24 w-full overflow-hidden bg-primary-100 dark:bg-primary-900/30">
                  <BrandImage
                    src={pick.restaurant.cover_image}
                    alt=""
                    sizes="(max-width: 640px) 50vw, 25vw"
                    className="img-zoom object-cover"
                  />
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent"
                  />
                  <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5 text-2xs font-semibold text-white backdrop-blur">
                    <svg
                      className="h-3 w-3 text-amber-400"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8L12 2z" />
                    </svg>
                    {pick.restaurant.rating != null ? pick.restaurant.rating.toFixed(1) : "New"}
                  </span>
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-bold text-neutral-900 dark:text-white">
                    {pick.restaurant.name}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500">
                    {pick.reason}
                  </p>
                </div>
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
                className="group block overflow-hidden rounded-2xl border-2 border-amber-400/60 bg-gradient-to-br from-amber-50 to-white shadow-elevation-1 transition-all duration-200 hover:-translate-y-1 hover:shadow-elevation-3 dark:from-amber-500/10 dark:to-neutral-900"
              >
                <div className="relative h-24 w-full overflow-hidden bg-amber-100 dark:bg-amber-900/20">
                  <BrandImage
                    src={feed.surprise_restaurant.restaurant.cover_image}
                    alt=""
                    sizes="(max-width: 640px) 50vw, 25vw"
                    className="img-zoom object-cover"
                  />
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 bg-gradient-to-t from-amber-950/50 to-transparent"
                  />
                  <Badge variant="gold" size="sm" className="absolute left-2 top-2">
                    Surprise
                  </Badge>
                </div>
                <div className="p-3">
                  <p className="truncate text-sm font-bold text-neutral-900 dark:text-white">
                    {feed.surprise_restaurant.restaurant.name}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">
                    {feed.surprise_restaurant.reason}
                  </p>
                </div>
              </Link>
            </m.li>
          )}
        </ul>
      )}
    </section>
  );
}
