"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { m } from "framer-motion";
import { Badge, Sheet } from "@snakzap/ui";
import type { Restaurant, MenuItem } from "@/lib/api";
import { useCartStore, type CartItem } from "@/lib/store";
import toast from "react-hot-toast";

interface RestaurantCardProps {
  restaurant: Restaurant;
  index: number;
}

export function RestaurantCard({ restaurant, index }: RestaurantCardProps) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loadingMenu, setLoadingMenu] = useState(false);
  const addItem = useCartStore((s) => s.addItem);

  const isOpen = restaurant.is_active;
  const etaLabel = isOpen ? `~${restaurant.pickup_eta_min} min` : "Opens 11:00";

  async function openQuickAdd() {
    setQuickAddOpen(true);
    if (menuItems.length > 0) return;
    setLoadingMenu(true);
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
      const res = await fetch(`${API_BASE}/api/v1/restaurants/${restaurant.id}/menu`, {
        cache: "no-store",
      });
      const body = await res.json();
      if (body.success) {
        setMenuItems(body.data.slice(0, 5));
      }
    } catch {
      // silent
    }
    setLoadingMenu(false);
  }

  function handleQuickAdd(item: MenuItem) {
    const cartItem: CartItem = {
      menuItemId: item.id,
      name: item.name,
      basePrice: item.price,
      quantity: 1,
      customizations: [],
      restaurantId: item.restaurant_id,
      restaurantName: restaurant.name,
    };
    const result = addItem(cartItem);
    if (result.cleared) {
      toast(
        () => (
          <span>
            Cart cleared from {result.previousRestaurantName}. Added from {restaurant.name}.
          </span>
        ),
        { duration: 3000 },
      );
    } else {
      toast.success(`${item.name} added to cart`);
    }
  }

  return (
    <>
      <m.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.05, duration: 0.3 }}
        className="h-full"
      >
        <Link
          href={`/restaurants/${restaurant.id}`}
          className="group block h-full overflow-hidden rounded-3xl bg-white shadow-elevation-1 ring-1 ring-neutral-900/5 transition-all duration-300 hover:-translate-y-1 hover:shadow-elevation-3 dark:bg-neutral-900 dark:ring-white/5"
        >
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-primary-100 dark:bg-primary-900/30">
            <Image
              src={`https://picsum.photos/seed/${restaurant.id}/600/450`}
              alt={restaurant.name}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              loading="lazy"
              className="img-zoom object-cover"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/0 to-black/10"
            />
            <div className="absolute left-3 top-3 flex gap-1.5">
              <Badge variant={isOpen ? "green" : "red"} size="sm" pulse={isOpen}>
                {isOpen ? "Open" : "Closed"}
              </Badge>
            </div>
            <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/45 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
              <svg
                className="h-3.5 w-3.5 text-amber-400"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8L12 2z" />
              </svg>
              4.5
            </span>
            <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
              <svg
                className="h-3.5 w-3.5 text-teal-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {etaLabel}
            </span>
          </div>
          <div className="p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="line-clamp-1 font-bold tracking-tight text-neutral-900 dark:text-white">
                {restaurant.name}
              </h3>
            </div>
            <p className="mt-1 line-clamp-1 text-xs text-neutral-400 dark:text-neutral-500">
              North Indian &middot; Biryani &middot; {isOpen ? "1.2 km" : "Opens 11:00"}
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openQuickAdd();
              }}
              className="btn-outline mt-3 w-full !min-h-10 !px-4 !py-2 !text-xs"
            >
              {isOpen ? "Quick add" : "View menu"}
            </button>
          </div>
        </Link>
      </m.div>

      <Sheet
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        title={`Quick Add - ${restaurant.name}`}
      >
        {loadingMenu ? (
          <div className="space-y-3 py-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-16 animate-skeleton-teal rounded-lg bg-primary-100 dark:bg-primary-900/30"
              />
            ))}
          </div>
        ) : menuItems.length === 0 ? (
          <p className="py-8 text-center text-sm text-neutral-500">No items available</p>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {menuItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                    {item.name}
                  </p>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500">
                    {new Intl.NumberFormat("en-IN", {
                      style: "currency",
                      currency: "INR",
                      minimumFractionDigits: 0,
                    }).format(item.price)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleQuickAdd(item)}
                  className="ml-3 shrink-0 rounded-full bg-primary-500 px-4 py-1.5 text-xs font-bold text-white transition-all duration-150 hover:bg-primary-hover active:scale-95"
                >
                  + Add
                </button>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}
