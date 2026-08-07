"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchPersonalizedHomepage, type PersonalizedHomepage } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// Personalized For You (D07): fetches /discovery/personalized-homepage with
// the signed-in token when available (otherwise the rule-based cold-start
// feed). Ranks restaurants by inferred preference and always surfaces one
// teal "surprise" pick so the feed cannot collapse into a filter bubble.

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
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-primary-700">
          Personalized For You
        </h2>
        {feed && (
          <span className="text-xs text-neutral-400">
            {feed.user_profile.strategy === "ml_weighted"
              ? "Recommended from your order history"
              : "Rule-based picks for a new foodie"}
          </span>
        )}
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</p>
      ) : feed === null ? (
        <div className="flex gap-4 overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 w-52 shrink-0 animate-skeleton-teal rounded-xl bg-primary-100"
            />
          ))}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {feed.personalized_restaurants.map((pick) => (
            <li key={pick.restaurant.id}>
              <Link
                href={`/restaurants/${pick.restaurant.id}`}
                className="block rounded-xl bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <p className="truncate font-semibold text-primary-700">
                  {pick.restaurant.name}
                </p>
                <p className="mt-1 text-xs text-neutral-400">{pick.reason}</p>
              </Link>
            </li>
          ))}
          {feed.surprise_restaurant && (
            <li>
              <Link
                href={`/restaurants/${feed.surprise_restaurant.restaurant.id}`}
                className="block rounded-xl border-2 border-primary-500/40 bg-primary-500/5 p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <span className="rounded-md bg-primary-500 px-1.5 py-0.5 text-[11px] font-bold text-white">
                  Surprise
                </span>
                <p className="mt-2 truncate font-semibold text-primary-700">
                  {feed.surprise_restaurant.restaurant.name}
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  {feed.surprise_restaurant.reason}
                </p>
              </Link>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
