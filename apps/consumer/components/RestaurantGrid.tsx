import Image from "next/image";
import Link from "next/link";
import type { Restaurant } from "@/lib/api";

// RSC photo-first grid (Instagram-style): fixed aspect-square tiles +
// lazy-loaded images guarantee zero layout shift. Tapping a card opens
// the restaurant menu page.

export function RestaurantGrid({
  restaurants,
}: {
  restaurants: Restaurant[];
}) {
  if (restaurants.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-neutral-500">
        No restaurants available right now.
      </p>
    );
  }

  return (
    <section
      aria-label="Restaurants"
      className="grid grid-cols-2 gap-4 sm:grid-cols-3"
    >
      {restaurants.map((restaurant) => {
        const badge = restaurant.is_active
          ? { label: "Open now", className: "bg-green-500/15 text-green-700" }
          : { label: "Closed", className: "bg-red-500/15 text-red-700" };
        return (
          <Link
            key={restaurant.id}
            href={`/restaurants/${restaurant.id}`}
            className="overflow-hidden rounded-xl bg-white shadow-sm transition-shadow hover:shadow-md"
          >
            <article>
              <div className="relative aspect-square w-full overflow-hidden bg-primary-500/10">
                <Image
                  src={`https://picsum.photos/seed/${restaurant.id}/400/400`}
                  alt={restaurant.name}
                  fill
                  sizes="(max-width: 640px) 50vw, 33vw"
                  loading="lazy"
                  className="object-cover"
                />
              </div>
              <div className="p-3">
                <h3 className="truncate font-semibold text-primary-700">
                  {restaurant.name}
                </h3>
                <span
                  className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${badge.className}`}
                >
                  {badge.label}
                </span>
              </div>
            </article>
          </Link>
        );
      })}
    </section>
  );
}


