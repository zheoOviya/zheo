"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { OrderTracker } from "@/components/OrderTracker";
import { QrCode } from "@/components/QrCode";
import StampCardProgress from "@/components/StampCardProgress";
import { useAuthStore } from "@/lib/store";
import {
  fetchRestaurants,
  fetchStampCard,
  fetchTrafficEta,
  type StampCard,
  type TrafficEta,
} from "@/lib/api";

interface OrderInfo {
  id: string;
  restaurant_id: string;
  status: string;
  pickup_otp: string | null;
  qr_token: string | null;
  total_amount: number;
  items: Array<{ name: string; quantity: number }>;
  checked_in: boolean;
}

// Fallback consumer location (Colaba, Mumbai) when geolocation is denied.
const FALLBACK_LOCATION = { lat: 18.9218, lng: 72.8308 };

function TrackingContent() {
  const params = useParams();
  const router = useRouter();
  const orderId = params.id as string;

  const accessToken = useAuthStore((s) => s.accessToken);
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [error, setError] = useState("");
  const [checkedIn, setCheckedIn] = useState(false);

  const [eta, setEta] = useState<TrafficEta | null>(null);
  const [etaLoading, setEtaLoading] = useState(true);
  const [stampCard, setStampCard] = useState<StampCard | null>(null);

  useEffect(() => {
    async function fetchOrder() {
      try {
        const res = await fetch(`/api/v1/orders/${orderId}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Order not found");
        const body = await res.json();
        setOrder(body.data);
        setCheckedIn(body.data.checked_in);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load order");
      }
    }
    fetchOrder();
  }, [orderId]);

  // P04 Traffic-based ETA: user location -> restaurant pickup location.
  useEffect(() => {
    if (!order) return;
    let cancelled = false;
    (async () => {
      try {
        const restaurants = await fetchRestaurants();
        const restaurant = restaurants.find(
          (r) => r.id === order.restaurant_id,
        );
        if (!restaurant?.lat || !restaurant.lng) {
          setEtaLoading(false);
          return;
        }
        const origin = await new Promise<{ lat: number; lng: number }>(
          (resolve) => {
            if (typeof navigator === "undefined" || !navigator.geolocation) {
              resolve(FALLBACK_LOCATION);
              return;
            }
            navigator.geolocation.getCurrentPosition(
              (pos) =>
                resolve({
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                }),
              () => resolve(FALLBACK_LOCATION),
              { timeout: 4000 },
            );
          },
        );
        const result = await fetchTrafficEta(origin, {
          lat: restaurant.lat,
          lng: restaurant.lng,
        });
        if (!cancelled) setEta(result);
      } catch {
        // ETA is a nice-to-have; never block the tracking page on it.
      } finally {
        if (!cancelled) setEtaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order]);

  // L01 Stamp card progress for this restaurant.
  useEffect(() => {
    if (!order || !accessToken) return;
    let cancelled = false;
    fetchStampCard(accessToken, order.restaurant_id)
      .then((card) => {
        if (!cancelled) setStampCard(card);
      })
      .catch(() => {
        // not authenticated / no card yet - show empty progress
      });
    return () => {
      cancelled = true;
    };
  }, [order, accessToken]);

  async function handleCheckIn() {
    try {
      const res = await fetch(
        `/api/v1/orders/${orderId}/check-in`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error("Check-in failed");
      setCheckedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check-in failed");
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-red-500">{error}</p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-4 rounded-full bg-primary-500 px-6 py-2 text-sm font-semibold text-white"
          >
            Back to Home
          </button>
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <p className="mt-4 text-sm text-neutral-400">Loading order...</p>
        </div>
      </main>
    );
  }

  const isReady = order.status === "READY_FOR_PICKUP";
  const isPickedUp = order.status === "PICKED_UP";

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mb-4 text-sm text-primary-600 hover:text-primary-700"
        >
          &larr; Back
        </button>
        <h1 className="text-2xl font-bold text-primary-700">Order Status</h1>
        <p className="mt-1 text-sm text-neutral-500">
          {order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
        </p>
      </header>

      <div className="space-y-6">
        {/* Live tracker */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <OrderTracker orderId={orderId} initialStatus={order.status} />
        </div>

        {/* P04 Traffic-based ETA: know exactly when to leave */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-primary-700">
              When to leave
            </h2>
            {eta && (
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold ${
                  eta.source === "google"
                    ? "bg-green-100 text-green-700"
                    : "bg-accent-100 text-accent-700"
                }`}
              >
                {eta.source === "google" ? "Live traffic" : "Estimated"}
              </span>
            )}
          </div>
          {etaLoading ? (
            <div className="mt-3 space-y-2">
              <div className="h-8 w-48 animate-skeleton-teal rounded bg-primary-200" />
              <div className="h-4 w-32 animate-skeleton-teal rounded bg-primary-200" />
            </div>
          ) : eta ? (
            <div className="mt-3">
              <p className="text-3xl font-bold text-primary-700">
                ~{eta.duration_text}
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                travel time to the restaurant
                {eta.distance_km > 0 ? ` (${eta.distance_km} km)` : ""}
              </p>
              <p className="mt-2 text-xs text-neutral-400">
                {eta.source === "google"
                  ? "Based on live traffic from Google Maps."
                  : "Estimate based on typical city traffic."}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-neutral-400">
              ETA unavailable for this restaurant.
            </p>
          )}
        </div>

        {/* L01 Stamp card progress for this restaurant */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-primary-700">
            Stamp Card
          </h2>
          <StampCardProgress
            stampCount={stampCard?.stamp_count ?? 0}
            rewardsEarned={stampCard?.rewards_earned ?? 0}
          />
        </div>

        {/* Check-in button */}
        {!isReady && !isPickedUp && (
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            {checkedIn ? (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                You are checked in. Staff knows you are here.
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCheckIn}
                className="w-full rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                I am Here (Check In)
              </button>
            )}
          </div>
        )}

        {/* QR Code + OTP for pickup */}
        {isReady && order.qr_token && (
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-neutral-700">
              Show this at the counter
            </h2>
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
              <QrCode value={order.qr_token} size={180} />
              <div className="text-center sm:text-left">
                <p className="text-sm text-neutral-500">Pickup Code</p>
                <p className="mt-2 text-4xl font-bold tracking-widest text-primary-700">
                  {order.pickup_otp}
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  Show this QR code or tell the staff this code
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Picked up confirmation */}
        {isPickedUp && (
          <div className="rounded-2xl bg-green-50 p-6 text-center shadow-sm">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
              <svg className="h-7 w-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-green-700">Order Picked Up!</p>
            <p className="mt-1 text-sm text-green-600">Enjoy your meal!</p>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="mt-4 rounded-full bg-green-600 px-6 py-2 text-sm font-semibold text-white hover:bg-green-700"
            >
              Order Again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export default function OrderTrackingPage() {
  return (
    <AuthGate>
      <TrackingContent />
    </AuthGate>
  );
}
