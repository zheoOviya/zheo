"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { MenuItem } from "@/lib/api";
import { fetchRestaurantMenu } from "@/lib/api";
import { BrandImage } from "@/components/BrandImage";
import { formatINR } from "@/lib/pricing";
import {
  useDineInSelectionStore,
  DINE_IN_MAX_QUANTITY,
} from "@/store/dineInSelection";
import { DineInOrderBar } from "./DineInOrderBar";
import { Skeleton } from "@snakzap/ui";

// ============================================
// Dine-in menu list + selection interaction (frozen UI2-B1 + UI3-B + UI4-A).
//
// Catalog: fetches the authoritative restaurant catalog once on mount via
// fetchRestaurantMenu(context.restaurant.id). Table/session ids are never used
// to select the catalog; sessionId is used ONLY to scope client selection.
//
// Selection (UI3-B): Add -> qty stepper [- qty +], max 50, decrement at 1 -> 0
// removes the line and restores Add. Purely client-memory — zero network
// requests, pickup cart untouched. displayPrice/displayTotal are UX-only
// ("Estimated total"); the backend re-prices at order time.
//
// Order (UI4-A): <DineInOrderBar> owns the sticky Place order CTA and the
// authenticated POST /orders submission. It renders fixed at the viewport
// bottom, so it escapes the card regardless of scroll position.
// ============================================
// Dine-In menu list + selection interaction (frozen UI2-B1 + UI3-B).
//
// Catalog: fetches the authoritative restaurant catalog once on mount via
// fetchRestaurantMenu(context.restaurant.id). Table/session ids are never used
// to select the catalog; sessionId is used ONLY to scope client selection.
//
// Selection (UI3-B): Add -> qty stepper [- qty +], max 50, decrement at 1 -> 0
// removes the line and restores Add. Purely client-memory — zero network
// requests, pickup cart untouched, no placeOrder. displayPrice/displayTotal
// are UX-only ("Estimated total"); the backend re-prices at order time.
// ============================================

type MenuStatus = "loading" | "success" | "error";

// Image with graceful failure: null src OR load failure renders the shared
// BrandImage placeholder (no broken-image icon, no layout collapse). Fixed
// square ratio is enforced by the parent h-20 w-20 container + object-cover.
function DineInItemImage({ src, sizes }: { src: string | null; sizes: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return <BrandImage src={null} />;
  }
  return (
    <Image
      src={src}
      alt=""
      fill
      sizes={sizes}
      className="object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function ItemCard({
  item,
  quantity,
  frozen,
  onAdd,
  onDecrement,
  onIncrement,
}: {
  item: MenuItem;
  quantity: number;
  frozen: boolean;
  onAdd: () => void;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  const tags = Object.entries(item.dietary_tags ?? {})
    .filter(([, on]) => on)
    .map(([tag]) => tag);
  const atMax = quantity >= DINE_IN_MAX_QUANTITY;

  return (
    <div className="surface-card flex items-center gap-3.5 p-3.5">
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-primary-100 dark:bg-primary-900/30">
        <DineInItemImage src={item.image_url} sizes="80px" />
        {tags[0] && (
          <span
            aria-label={tags[0]}
            aria-hidden="false"
            className={`absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white ${
              tags[0] === "NON_VEG" ? "bg-red-600" : "bg-green-600"
            }`}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-1 text-sm font-bold tracking-tight text-neutral-900 dark:text-white">
          {item.name}
        </h3>
        <p className="mt-1 text-sm font-extrabold text-primary-700 dark:text-primary-300">
          {formatINR(item.price)}
        </p>
      </div>

      {frozen ? null : quantity === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add ${item.name}`}
          className="shrink-0 rounded-full bg-primary-500 px-4 py-2 text-xs font-bold text-white hover:bg-primary-hover active:scale-95"
        >
          Add
        </button>
      ) : (
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-primary-500/10 p-1">
          <button
            type="button"
            onClick={onDecrement}
            aria-label={`Decrease ${item.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-primary-700 shadow-sm active:scale-95"
          >
            <MinusIcon className="h-3.5 w-3.5" />
          </button>
          <span
            aria-label={`${item.name} quantity`}
            aria-live="polite"
            className="min-w-[1.5rem] text-center text-sm font-bold text-primary-700"
          >
            {quantity}
          </span>
          <button
            type="button"
            onClick={onIncrement}
            disabled={atMax}
            aria-disabled={atMax}
            aria-label={`Increase ${item.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-primary-700 shadow-sm active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function MenuSkeletons() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="surface-card flex items-center gap-3.5 p-3.5">
          <Skeleton className="h-20 w-20 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/4" />
          </div>
          <Skeleton className="h-8 w-14 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function DineInMenuList({
  restaurantId,
  sessionId,
  frozen = false,
}: {
  restaurantId: string;
  sessionId: string;
  frozen?: boolean;
}) {
  const [status, setStatus] = useState<MenuStatus>("loading");
  const [items, setItems] = useState<MenuItem[]>([]);
  const autoFetchedRef = useRef(false);
  const activeRef = useRef(true);

  // UI3-B: selection scoped to this session. Same session -> keep lines; a
  // different session (or none) -> reset. Wiring lives here in the menu layer.
  useEffect(() => {
    useDineInSelectionStore.getState().ensureScope(sessionId);
  }, [sessionId]);

  const load = useCallback(async () => {
    setStatus("loading");
    setItems([]);
    try {
      const data = await fetchRestaurantMenu(restaurantId);
      if (!activeRef.current) return;
      setItems(data);
      setStatus("success");
    } catch {
      if (!activeRef.current) return;
      setStatus("error");
    }
  }, [restaurantId]);

  // Fetch exactly once on initial mount (ref guard survives StrictMode double
  // effects). Retry calls load() directly and bypasses the guard.
  useEffect(() => {
    activeRef.current = true;
    if (!autoFetchedRef.current) {
      autoFetchedRef.current = true;
      void load();
    }
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  const lines = useDineInSelectionStore((s) => s.lines);
  const qtyById = new Map(lines.map((l) => [l.menuItemId, l.quantity]));

  const handleAdd = useCallback((item: MenuItem) => {
    useDineInSelectionStore.getState().add({
      menuItemId: item.id,
      name: item.name,
      displayPrice: item.price,
    });
  }, []);

  const handleDecrement = useCallback((item: MenuItem) => {
    const qty = useDineInSelectionStore.getState().lines.find(
      (l) => l.menuItemId === item.id,
    )?.quantity;
    useDineInSelectionStore.getState().setQuantity(item.id, (qty ?? 1) - 1);
  }, []);

  const handleIncrement = useCallback((item: MenuItem) => {
    const qty = useDineInSelectionStore.getState().lines.find(
      (l) => l.menuItemId === item.id,
    )?.quantity;
    useDineInSelectionStore.getState().setQuantity(item.id, (qty ?? 0) + 1);
  }, []);

  if (status === "loading") {
    return <MenuSkeletons />;
  }

  if (status === "error") {
    return (
      <div className="surface-card p-6 text-center">
        <p role="alert" className="text-sm font-bold text-neutral-900 dark:text-white">
          We couldn&apos;t load the menu
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Check your connection and try again.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="btn-primary mt-4 min-h-[44px] w-full"
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="surface-card py-10 text-center text-sm text-neutral-400">
        No items on the menu right now.
      </p>
    );
  }

  // UI7-B Repair A: the fixed CTA bar (p-4 + CTA card + safe-area bottom)
  // overlays the last menu row. A deterministic bottom spacer matching that
  // footprint (84px + max(1rem, safe-area) + margin) is rendered only while a
  // selection exists and ordering is not frozen — i.e. exactly when the sticky
  // Place order CTA is visible. Transient success/error banners are taller;
  // the persistent CTA (the audit's occlusion source) is always cleared.
  const hasSelection = lines.length > 0;

  return (
    <>
      <div className="space-y-3">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            quantity={qtyById.get(item.id) ?? 0}
            frozen={frozen}
            onAdd={() => handleAdd(item)}
            onDecrement={() => handleDecrement(item)}
            onIncrement={() => handleIncrement(item)}
          />
        ))}
      </div>
      {!frozen && hasSelection && (
        <div
          aria-hidden="true"
          data-testid="dine-in-menu-bottom-spacer"
          className="h-[calc(92px+max(1rem,env(safe-area-inset-bottom)))]"
        />
      )}
      <DineInOrderBar onRefreshMenu={() => void load()} frozen={frozen} />
    </>
  );
}
