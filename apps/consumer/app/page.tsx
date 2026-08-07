import Link from "next/link";
import { fetchRestaurants } from "@/lib/api";
import { RestaurantGrid } from "@/components/RestaurantGrid";
import { DiscoveryControls } from "@/components/DiscoveryControls";
import { PersonalizedFeed } from "@/components/PersonalizedFeed";
import { TrendingCarousel } from "@/components/TrendingCarousel";

// RSC: server-fetches active restaurants, renders the photo-first grid.
// Interactive search + dietary filtering live in the client island below.
export default async function HomePage() {
  const restaurants = await fetchRestaurants();

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-700">SnakZap</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Order ahead, skip the wait.
          </p>
        </div>
        <nav className="flex gap-3">
          <Link
            href="/login"
            className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
          >
            Sign In
          </Link>
          <Link
            href="/profile"
            className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
          >
            Profile
          </Link>
          <Link
            href="/checkout"
            className="rounded-full bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Cart
          </Link>
        </nav>
      </header>

      <div className="mb-8 space-y-4">
        <DiscoveryControls />
      </div>

      <PersonalizedFeed />
      <TrendingCarousel />

      <h2 className="mb-4 mt-8 text-lg font-semibold text-primary-700">
        Restaurants near you
      </h2>
      <RestaurantGrid restaurants={restaurants} />
    </main>
  );
}
