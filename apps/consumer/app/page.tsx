import Link from "next/link";
import { MapPinIcon, ChevronDoubleDownIcon } from "@heroicons/react/24/outline";
import { fetchRestaurants } from "@/lib/api";
import { RestaurantGrid } from "@/components/RestaurantGrid";
import { DiscoveryControls } from "@/components/DiscoveryControls";
import { PersonalizedFeed } from "@/components/PersonalizedFeed";
import { TrendingCarousel } from "@/components/TrendingCarousel";
import { AccountEntry } from "@/components/AccountEntry";
import { BrandMark } from "@/components/AppHeader";

export default async function HomePage() {
  let restaurants: Awaited<ReturnType<typeof fetchRestaurants>> = [];
  let loadError = "";

  try {
    restaurants = await fetchRestaurants();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load restaurants";
  }

  const openCount = restaurants.filter((r) => r.is_active).length;
  const avgEta =
    restaurants.length > 0
      ? Math.round(restaurants.reduce((sum, r) => sum + r.pickup_eta_min, 0) / restaurants.length)
      : 20;

  return (
    <main className="pb-2 pt-4">
      <header className="mb-5 flex items-center justify-between">
        <BrandMark />
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-500/10 px-3.5 py-2 text-sm font-semibold text-primary-700 ring-1 ring-primary-500/20 dark:bg-primary-400/15 dark:text-primary-300 dark:ring-primary-400/25">
            <MapPinIcon className="h-3.5 w-3.5" />
            Gachibowli
          </span>
          <AccountEntry />
        </div>
      </header>

      <section className="hero-panel relative overflow-hidden rounded-3xl p-6 shadow-elevation-2 sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <svg
            className="absolute -right-10 -top-10 h-48 w-48 text-white/10"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M12 2c.6 0 1.1.4 1.2 1l.9 4.6c1.6-1.2 3.6-1.6 5.5-1l-.3 1.2c-1.6-.5-3.3-.3-4.7.6L21 14l-6.9 3.4 3.7 5.8-1 1.6-3.7-5.8-3.7 5.8-1-1.6 3.7-5.8L3 14l6.4-5.6c-1.4-.9-3.1-1.1-4.7-.6l-.3-1.2c1.9-.6 3.9-.2 5.5 1L10.8 3c.1-.6.6-1 1.2-1z" />
          </svg>
        </div>
        <div className="relative">
          <p className="text-2xs font-bold uppercase tracking-[0.18em] text-teal-200">
            Pickup-first food ordering
          </p>
          <h1 className="mt-2 max-w-md text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
            Skip the queue. Grab the flavor.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-teal-100/90">
            Order ahead from restaurants near you, breeze past the line, and pick up exactly when
            it&rsquo;s ready.
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            <a href="#restaurants" className="hero-cta-primary">
              Browse restaurants
              <ChevronDoubleDownIcon className="h-4 w-4" />
            </a>
            <Link href="/orders" className="hero-cta-secondary">
              Track an order
            </Link>
          </div>
          <dl className="mt-6 flex items-center gap-6 text-white">
            <div>
              <dt className="text-2xs font-semibold uppercase tracking-wider text-teal-200">
                Open now
              </dt>
              <dd className="text-lg font-bold">{openCount}</dd>
            </div>
            <div aria-hidden="true" className="h-8 w-px bg-white/20" />
            <div>
              <dt className="text-2xs font-semibold uppercase tracking-wider text-teal-200">
                Avg. pickup
              </dt>
              <dd className="text-lg font-bold">~{avgEta} min</dd>
            </div>
            <div aria-hidden="true" className="h-8 w-px bg-white/20" />
            <div>
              <dt className="text-2xs font-semibold uppercase tracking-wider text-teal-200">
                Mode
              </dt>
              <dd className="text-lg font-bold">Pickup</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="mt-5 space-y-4">
        <DiscoveryControls />
      </section>

      <PersonalizedFeed />
      <TrendingCarousel />

      <section id="restaurants" aria-label="Restaurants near you" className="mt-8 scroll-mt-6">
        <div className="section-head">
          <div>
            <p className="section-eyebrow">For you</p>
            <h2 className="section-title">Restaurants near you</h2>
          </div>
          <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500">
            {restaurants.length} available
          </span>
        </div>
        {loadError ? (
          <p role="alert" className="surface-card mb-4 p-3 text-sm text-red-600 dark:text-red-400">
            {loadError}. Please try again later.
          </p>
        ) : (
          <RestaurantGrid restaurants={restaurants} />
        )}
      </section>
    </main>
  );
}
