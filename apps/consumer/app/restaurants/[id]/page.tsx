import Link from "next/link";
import type { Metadata } from "next";
import { fetchRestaurants, fetchRestaurantMenu } from "@/lib/api";
import { MenuItemsList } from "@/components/MenuItemsList";

// RSC menu page: server-fetches the restaurant + menu, renders the
// interactive add-to-cart island below (RSC-first, client island pattern).

export const metadata: Metadata = {
  title: "Menu - SnakZap",
};

export default async function RestaurantMenuPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [restaurants, menu] = await Promise.all([
    fetchRestaurants(),
    fetchRestaurantMenu(id),
  ]);
  const restaurant = restaurants.find((r) => r.id === id);

  if (!restaurant) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-neutral-700">
            Restaurant not found
          </h1>
          <Link
            href="/"
            className="mt-4 inline-block rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Back to Home
          </Link>
        </div>
      </main>
    );
  }

  const tag =
    restaurant.is_active
      ? { label: "Open now", color: "bg-green-500/15 text-green-700" }
      : { label: "Closed", color: "bg-red-500/15 text-red-700" };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 pb-28">
      <header className="mb-6">
        <Link
          href="/"
          className="mb-4 inline-block text-sm text-primary-600 hover:text-primary-700"
        >
          &larr; Back
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-primary-700">
            {restaurant.name}
          </h1>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tag.color}`}
          >
            {tag.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Order ahead, skip the wait. Pickup only.
        </p>
      </header>

      <section aria-label="Menu">
        <h2 className="mb-3 text-lg font-semibold text-primary-700">Menu</h2>
        <MenuItemsList
          restaurantId={restaurant.id}
          restaurantName={restaurant.name}
          items={menu}
        />
      </section>
    </main>
  );
}
