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

  const queueStatus = restaurant.is_active ? "Light" : "Closed";
  const queueColor: "green" | "red" = restaurant.is_active ? "green" : "red";

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
      >
        <Link
          href={`/restaurants/${restaurant.id}`}
          className="block overflow-hidden rounded-xl bg-white dark:bg-neutral-900 shadow-elevation-1 hover:shadow-elevation-3 transition-all duration-200 hover:-translate-y-1"
        >
          <div className="relative aspect-square w-full overflow-hidden bg-primary-100 dark:bg-primary-900/30">
            <Image
              src={`https://picsum.photos/seed/${restaurant.id}/400/400`}
              alt={restaurant.name}
              fill
              sizes="(max-width: 640px) 50vw, 33vw"
              loading="lazy"
              className="object-cover"
            />
            <div className="absolute top-2 left-2 flex gap-1.5">
              <Badge variant={restaurant.is_active ? "green" : "red"} size="sm" pulse={restaurant.is_active}>
                {restaurant.is_active ? "Open" : "Closed"}
              </Badge>
            </div>
          </div>
          <div className="p-3">
            <h3 className="truncate font-semibold text-primary-700 dark:text-primary-300">
              {restaurant.name}
            </h3>
            <div className="mt-2 flex items-center gap-2">
              <Badge variant={queueColor} size="sm">
                {queueStatus} Queue
              </Badge>
              <span className="text-2xs text-neutral-400 dark:text-neutral-500">
                ~15 min
              </span>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openQuickAdd();
              }}
              className="mt-2.5 w-full rounded-lg bg-primary/10 dark:bg-primary/20 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 dark:hover:bg-primary/30"
            >
              Quick Add
            </button>
          </div>
        </Link>
      </m.div>

      <Sheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} title={`Quick Add - ${restaurant.name}`}>
        {loadingMenu ? (
          <div className="space-y-3 py-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-skeleton-teal rounded-lg bg-primary-100 dark:bg-primary-900/30" />
            ))}
          </div>
        ) : menuItems.length === 0 ? (
          <p className="py-8 text-center text-sm text-neutral-500">No items available</p>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {menuItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
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
                  className="ml-3 shrink-0 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-white transition-all duration-150 active:scale-95 hover:bg-primary-hover"
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
