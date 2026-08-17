import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeftIcon, ClockIcon, UserIcon } from "@heroicons/react/24/outline";
import { fetchRestaurants, fetchRestaurantMenu } from "@/lib/api";
import { MenuItemsList } from "@/components/MenuItemsList";
import { BrandImage } from "@/components/BrandImage";

// RSC menu page: server-fetches the restaurant + menu, renders the
// interactive add-to-cart island below (RSC-first, client island pattern).

export const metadata: Metadata = {
  title: "Menu - SnakZap",
};

export default async function RestaurantMenuPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let restaurants: Awaited<ReturnType<typeof fetchRestaurants>> = [];
  let menu: Awaited<ReturnType<typeof fetchRestaurantMenu>> = [];
  let loadError = "";

  try {
    [restaurants, menu] = await Promise.all([fetchRestaurants(), fetchRestaurantMenu(id)]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load menu";
  }

  const restaurant = restaurants.find((r) => r.id === id);

  if (loadError) {
    return (
      <main className="py-6">
        <div className="surface-card p-10 text-center">
          <p
            role="alert"
            className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400"
          >
            {loadError}. Please try again later.
          </p>
          <Link href="/" className="btn-primary mt-4">
            Back to Home
          </Link>
        </div>
      </main>
    );
  }

  if (!restaurant) {
    return (
      <main className="py-6">
        <div className="surface-card p-10 text-center">
          <h1 className="text-lg font-semibold text-neutral-700 dark:text-neutral-200">
            Restaurant not found
          </h1>
          <Link href="/" className="btn-primary mt-4">
            Back to Home
          </Link>
        </div>
      </main>
    );
  }

  const tag = restaurant.is_active
    ? { label: "Open now", color: "bg-green-500/15 text-green-700 dark:text-green-400" }
    : { label: "Closed", color: "bg-red-500/15 text-red-700 dark:text-red-400" };

  return (
    <main className="pb-28 pt-0">
      <header className="relative mb-6">
        <div className="relative h-44 w-full overflow-hidden rounded-b-3xl bg-primary-100 dark:bg-primary-900/30">
          <BrandImage
            src={restaurant.cover_image}
            alt=""
            sizes="100vw"
            priority
            className="object-cover"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-neutral-950/80 via-neutral-950/25 to-neutral-950/30"
          />
          <Link
            href="/"
            aria-label="Back to home"
            className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/60"
          >
            <ChevronLeftIcon className="h-5 w-5" />
          </Link>
        </div>
        <div className="px-1">
          <div className="-mt-8 flex items-end justify-between">
            <h1 className="text-2xl font-extrabold tracking-tight text-neutral-900 dark:text-white">
              {restaurant.name}
            </h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tag.color}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${restaurant.is_active ? "bg-green-500" : "bg-red-500"}`}
              />
              {tag.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary-500/10 px-2.5 py-0.5 text-xs font-semibold text-primary-700 dark:text-primary-300">
              <ClockIcon className="h-3.5 w-3.5" />
              ~{restaurant.pickup_eta_min} min pickup
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-neutral-500/10 px-2.5 py-0.5 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
              <UserIcon className="h-3.5 w-3.5" />
              Pickup only
            </span>
          </div>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            Order ahead, skip the wait. Pick up exactly when it&rsquo;s ready.
          </p>
        </div>
      </header>

      <section aria-label="Menu" className="px-1">
        <div className="section-head">
          <div>
            <p className="section-eyebrow">Menu</p>
            <h2 className="section-title">What&rsquo;s cooking</h2>
          </div>
        </div>
        <MenuItemsList restaurantId={restaurant.id} restaurantName={restaurant.name} items={menu} />
      </section>
    </main>
  );
}
