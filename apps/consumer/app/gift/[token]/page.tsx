"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GiftIcon, ArrowRightIcon, UserIcon } from "@heroicons/react/24/outline";
import { fetchGiftLanding, claimGift, type GiftLanding } from "@/lib/api";
import { useAuthStore, useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/pricing";
import { BrandImage } from "@/components/BrandImage";
import toast from "react-hot-toast";

export default function GiftClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [landing, setLanding] = useState<GiftLanding | null>(null);
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const { accessToken, isAuthenticated } = useAuthStore();
  const addItem = useCartStore((s) => s.addItem);

  useEffect(() => {
    void params.then(({ token: t }) => setToken(t));
  }, [params]);

  const load = useCallback(async () => {
    if (!token) return;
    setError("");
    try {
      setLanding(await fetchGiftLanding(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load gift");
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  async function handleClaim() {
    if (!token) return;
    if (!isAuthenticated || !accessToken) {
      router.push(`/login?next=/gift/${encodeURIComponent(token)}`);
      return;
    }
    if (!landing) return;
    setClaiming(true);
    setError("");
    try {
      const gift = await claimGift(accessToken, token);
      addItem({
        menuItemId: gift.menu_item_id,
        name: gift.item_snapshot.name,
        basePrice: 0,
        quantity: 1,
        customizations: gift.item_snapshot.customizations,
        restaurantId: gift.restaurant_id,
        giftId: gift.id,
        giftToken: gift.claim_token,
      });
      toast.success("Gift claimed! It is in your cart at no cost.");
      router.push(`/restaurants/${encodeURIComponent(gift.restaurant_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not claim gift");
      setClaiming(false);
    }
  }

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-elevation-2 dark:bg-neutral-900">
          <p role="alert" className="text-sm text-red-600">{error}</p>
          <Link href="/" className="btn-primary mt-5">Back to Home</Link>
        </div>
      </main>
    );
  }

  if (!landing) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
      </main>
    );
  }

  const { gift, restaurant, sender_display } = landing;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-primary-600 via-primary-500 to-primary-700 p-6">
      <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-elevation-3 dark:bg-neutral-900">
        <div className="relative h-40 bg-primary-100 dark:bg-primary-900/30">
          <BrandImage src={restaurant?.image_url} alt="" sizes="400px" className="object-cover" />
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-neutral-950/70 to-transparent" />
          <span className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur">
            <GiftIcon className="h-5 w-5" />
          </span>
          <div className="absolute bottom-3 left-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/80">A gift for you</p>
            <p className="text-lg font-extrabold">{sender_display}</p>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-extrabold text-neutral-900 dark:text-white">{gift.item_snapshot.name}</h1>
              <p className="mt-0.5 text-sm text-neutral-500">{restaurant?.name ?? "SnakZap restaurant"}</p>
            </div>
            <span className="shrink-0 rounded-full bg-green-500/10 px-3 py-1 text-xs font-bold text-green-700">
              Paid
            </span>
          </div>

          {gift.item_snapshot.spice_level > 0 && (
            <p className="mt-2 text-xs font-semibold text-neutral-500">
              Spice {gift.item_snapshot.spice_level}/5
            </p>
          )}
          {gift.item_snapshot.customizations.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {gift.item_snapshot.customizations.map((c) => `${c.name} (+${formatINR(c.price_delta)})`).join(", ")}
            </p>
          )}
          {gift.message && (
            <blockquote className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm italic text-neutral-600 dark:bg-neutral-800">
              &ldquo;{gift.message}&rdquo;
            </blockquote>
          )}

          <p className="mt-3 text-sm text-neutral-400">
            Code: <span className="font-mono font-bold tracking-widest">{gift.claim_code}</span>
          </p>

          {landing.claimable ? (
            <button
              type="button"
              disabled={claiming}
              onClick={() => void handleClaim()}
              className="mt-5 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm disabled:opacity-50"
            >
              Claim gift <ArrowRightIcon className="h-4 w-4" />
            </button>
          ) : (
            <p role="status" className="mt-5 rounded-xl bg-neutral-100 p-3 text-center text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {landing.claim_block_reason ?? "This gift is no longer available"}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">{error}</p>
          )}

          <div className="mt-4 flex items-center justify-center gap-1 text-xs text-neutral-400">
            <UserIcon className="h-3.5 w-3.5" />
            Claim with your phone number — pays nothing
          </div>
        </div>
      </div>
    </main>
  );
}
