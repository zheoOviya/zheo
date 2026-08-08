import { fetchRestaurants } from "@/lib/api";
import { RestaurantGrid } from "@/components/RestaurantGrid";
import { DiscoveryControls } from "@/components/DiscoveryControls";
import { PersonalizedFeed } from "@/components/PersonalizedFeed";
import { TrendingCarousel } from "@/components/TrendingCarousel";

export default async function HomePage() {
  let restaurants: Awaited<ReturnType<typeof fetchRestaurants>> = [];
  let loadError = "";

  try {
    restaurants = await fetchRestaurants();
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load restaurants";
  }

  return (
    <main className="py-4">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-primary-700 dark:text-primary-300">
          SnakZap
        </h1>
        <p className="mt-0.5 text-sm text-neutral-400 dark:text-neutral-500">
          Order ahead, skip the wait.
        </p>
      </header>

      <div className="mb-6 space-y-4">
        <DiscoveryControls />
      </div>

      <PersonalizedFeed />
      <TrendingCarousel />

      <h2 className="mb-3 mt-6 text-lg font-bold text-primary-700 dark:text-primary-300">
        Restaurants near you
      </h2>
      {loadError ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400"
        >
          {loadError}. Please try again later.
        </p>
      ) : (
        <RestaurantGrid restaurants={restaurants} />
      )}
    </main>
  );
}
