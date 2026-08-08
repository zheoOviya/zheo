"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { useAuthStore } from "@/lib/store";
import { useCartStore } from "@/lib/store";
import { createPaymentOrder, simulatePaymentWebhook } from "@/lib/api";
import { loadRazorpayScript, createRazorpayInstance } from "@/lib/razorpay";
import { computePriceBreakdown, formatINR } from "@/lib/pricing";
import { EmptyState } from "@snakzap/ui";

type CheckoutStep = "cart" | "creating" | "payment" | "success" | "failed";

interface PickupSlot {
  time: string;
  label: string;
  available: boolean;
  current_orders: number;
  max_capacity: number;
}

function PickupSlotSelector({
  restaurantId,
  selectedSlot,
  onSelect,
}: {
  restaurantId: string;
  selectedSlot: string | null;
  onSelect: (slot: string | null) => void;
}) {
  const [showGrid, setShowGrid] = useState(false);
  const [slots, setSlots] = useState<PickupSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const today = new Date().toISOString().slice(0, 10);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/v1/restaurants/${restaurantId}/pickup-slots?date=${today}`,
      );
      if (!res.ok) throw new Error("Failed to load slots");
      const body = await res.json();
      setSlots(body.data.slots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load pickup slots");
    } finally {
      setLoading(false);
    }
  }, [restaurantId, today]);

  useEffect(() => {
    if (showGrid && slots.length === 0) {
      fetchSlots();
    }
  }, [showGrid, slots.length, fetchSlots]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showGrid) return;
    const enabledSlots = slots.filter((s) => s.available);
    if (enabledSlots.length === 0) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev + 1) % enabledSlots.length);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex(
        (prev) => (prev - 1 + enabledSlots.length) % enabledSlots.length,
      );
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const slot = enabledSlots[focusedIndex];
      if (slot) {
        onSelect(slot.time);
        setShowGrid(false);
      }
    }
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold text-neutral-700">
        Pickup Time
      </h2>

      <div role="radiogroup" aria-label="Pickup time selection" onKeyDown={handleKeyDown}>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-primary-500/20 p-4">
          <input
            type="radio"
            name="pickup_slot"
            className="h-4 w-4 accent-primary-500"
            checked={selectedSlot === null}
            onChange={() => { setShowGrid(false); onSelect(null); }}
          />
          <div>
            <p className="text-sm font-semibold text-neutral-700">
              ASAP (~15 min)
            </p>
            <p className="text-xs text-neutral-400">
              Pick up as soon as it is ready
            </p>
          </div>
        </label>

        <div className="mt-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-primary-500/20 p-4">
            <input
              type="radio"
              name="pickup_slot"
              className="h-4 w-4 accent-primary-500"
              checked={selectedSlot !== null}
              onChange={() => setShowGrid(true)}
            />
            <div>
              <p className="text-sm font-semibold text-neutral-700">
                Schedule for later
              </p>
              <p className="text-xs text-neutral-400">
                Choose a specific pickup time
              </p>
            </div>
          </label>

          {showGrid && (
            <div className="mt-3">
              {loading ? (
                <div className="flex justify-center py-4">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                </div>
              ) : error ? (
                <p className="py-4 text-center text-sm text-red-500">{error}</p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Available pickup time slots"
                  className="grid grid-cols-4 gap-2"
                  onKeyDown={handleKeyDown}
                >
                  {slots.map((slot, index) => {
                    const enabledSlots = slots.filter((s) => s.available);
                    const enabledIndex = enabledSlots.indexOf(slot);
                    const isFocused = enabledIndex === focusedIndex;
                    const isSelected = selectedSlot === slot.time;

                    return (
                      <button
                        key={slot.time}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        aria-disabled={!slot.available}
                        disabled={!slot.available}
                        tabIndex={isFocused ? 0 : -1}
                        onClick={() => {
                          if (slot.available) {
                            onSelect(slot.time);
                            setShowGrid(false);
                          }
                        }}
                        className={`rounded-lg border px-2 py-2.5 text-xs font-medium transition-colors ${
                          isSelected
                            ? "border-primary-500 bg-primary-500/10 text-primary-700"
                            : slot.available
                              ? "border-neutral-200 text-neutral-600 hover:border-primary-500/50"
                              : "cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-300"
                        }`}
                      >
                        <div>{slot.label}</div>
                        {!slot.available && (
                          <div className="mt-0.5 text-2xs">Full</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {selectedSlot && (
            <p className="mt-2 text-xs text-primary-600">
              Pickup at: {selectedSlot}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckoutContent() {
  const router = useRouter();
  const { user, accessToken, logout } = useAuthStore();
  const { items, clear } = useCartStore();
  const breakdown = computePriceBreakdown(items);

  const [step, setStep] = useState<CheckoutStep>("cart");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [rpOrderId, setRpOrderId] = useState<string | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false);
  const [pickupSlot, setPickupSlot] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (step !== "payment" || !rpOrderId) return;

    const openRazorpay = async () => {
      const loaded = await loadRazorpayScript();
      if (!loaded) {
        setError("Failed to load payment gateway");
        setStep("cart");
        return;
      }

      const rzp = createRazorpayInstance({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_placeholder",
        amount: amount * 100,
        currency: "INR",
        name: "SnakZap",
        description: `Order #${orderId}`,
        order_id: rpOrderId,
        prefill: { contact: user?.phone || "" },
        theme: { color: "#0D9488" },
        handler: async (response) => {
          setProcessing(true);
          try {
            await simulatePaymentWebhook(rpOrderId, amount, true);
            clear();
            setStep("success");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Payment verification failed");
            setStep("payment");
          } finally {
            setProcessing(false);
          }
        },
        modal: {
          ondismiss: () => {
            setError("Payment was cancelled. You can try again.");
            setStep("payment");
          },
        },
      });
      rzp.open();
    };

    openRazorpay();
  }, [step, rpOrderId, amount, orderId, user?.phone, clear, retryCount]);

  async function handlePlaceOrder() {
    if (!accessToken) return;
    setStep("creating");
    setError("");

    try {
      const today = new Date().toISOString().slice(0, 10);
      const scheduledPickupTime = pickupSlot
        ? new Date(`${today}T${pickupSlot}:00+05:30`).toISOString()
        : undefined;

      const res = await fetch("/api/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          restaurant_id: items[0]?.restaurantId,
          items: items.map((item) => ({
            menu_item_id: item.menuItemId,
            quantity: item.quantity,
            customizations: item.customizations,
          })),
          ...(scheduledPickupTime ? { scheduled_pickup_time: scheduledPickupTime } : {}),
        }),
        credentials: "include",
      });
      const body = await res.json();
      if (!body.success) {
        throw new Error(body.error?.message ?? "Order creation failed");
      }

      const createdOrderId = body.data.id;
      setOrderId(createdOrderId);

      const payment = await createPaymentOrder(createdOrderId, accessToken);
      setRpOrderId(payment.razorpay_order_id);
      setAmount(payment.amount);
      setStep("payment");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStep("cart");
    }
  }

  async function handleSimulatePayment(success: boolean) {
    if (!rpOrderId || processing) return;
    setProcessing(true);
    setError("");
    try {
      // Replay the Razorpay webhook so the server order state is real:
      // DRAFT -> PAYMENT_PENDING -> CONFIRMED / PAYMENT_FAILED.
      await simulatePaymentWebhook(rpOrderId, amount, success);
      if (success) {
        clear();
        setStep("success");
      } else {
        setStep("failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
      setStep("payment");
    } finally {
      setProcessing(false);
    }
  }

  if (step === "success") {
    return (
      <main className="py-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-primary-700">Checkout</h1>
        </header>
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary-500/10">
            <svg className="h-8 w-8 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-neutral-700">Order Confirmed!</h2>
          <p className="mt-2 text-sm text-neutral-500">
            Your order has been placed and payment is being processed.
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            You will receive a pickup OTP when your order is ready.
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-6 min-h-[44px] rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Back to Home
          </button>
        </div>
      </main>
    );
  }

  if (step === "failed") {
    return (
      <main className="py-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-primary-700">Checkout</h1>
        </header>
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-neutral-700">Payment Failed</h2>
          <p className="mt-2 text-sm text-neutral-500">
            Your payment could not be processed. Please try again.
          </p>
          <button
            type="button"
            onClick={() => setStep("payment")}
            className="mt-6 min-h-[44px] rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Try Again
          </button>
        </div>
      </main>
    );
  }

  if (step === "payment" && rpOrderId) {
    return (
      <main className="py-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-primary-700">Checkout</h1>
        </header>
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            <p className="text-sm text-neutral-500">
              {processing ? "Processing payment..." : "Opening payment gateway..."}
            </p>
            <p className="text-lg font-bold text-primary-700">{formatINR(amount)}</p>
          </div>
          {error && (
            <div className="mt-4 space-y-3">
              <p className="rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setRetryCount((count) => count + 1);
                }}
                className="w-full min-h-[44px] rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-700">Checkout</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {user?.phone ? `Signed in as +91 ${user.phone}` : "Preparing your order"}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => {
            await logout();
            router.push("/login");
          }}
          className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light"
        >
          Sign Out
        </button>
      </header>

      {items.length === 0 ? (
        <EmptyState
          icon={
            <svg
              aria-hidden="true"
              className="h-10 w-10 text-primary-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
              />
            </svg>
          }
          title="Your cart is empty"
          description="Add items from a restaurant to continue."
          cta={
            <button
              type="button"
              onClick={() => router.push("/")}
              className="min-h-[44px] rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              Browse Restaurants
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-neutral-700">
              Order Summary ({breakdown.itemCount} items)
            </h2>
            <ul className="space-y-3">
              {items.map((item) => {
                const customTotal = item.customizations.reduce(
                  (s, c) => s + c.price_delta, 0,
                );
                const unitPrice = item.basePrice + customTotal;
                return (
                  <li
                    key={item.menuItemId}
                    className="flex justify-between text-sm"
                  >
                    <span className="text-neutral-600">
                      {item.name} x{item.quantity}
                      {item.customizations.length > 0 &&
                        ` (${item.customizations.map((c) => c.name).join(", ")})`}
                    </span>
                    <span className="font-medium text-neutral-700">
                      {formatINR(unitPrice * item.quantity)}
                    </span>
                  </li>
                );
              })}
            </ul>

            <hr className="my-4 border-primary-500/20" />

            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-neutral-600">
                <span>Food Subtotal</span>
                <span>{formatINR(breakdown.foodSubtotal)}</span>
              </div>
              <div className="flex justify-between text-neutral-600">
                <span>GST on Food (5%)</span>
                <span>{formatINR(breakdown.gstFood)}</span>
              </div>
              <div className="flex justify-between text-neutral-600">
                <span>Packaging Fee</span>
                <span>{formatINR(breakdown.packagingFee)}</span>
              </div>
              <div className="flex justify-between text-neutral-600">
                <span>GST on Packaging (18%)</span>
                <span>{formatINR(breakdown.gstPackaging)}</span>
              </div>
            </div>

            <hr className="my-4 border-primary-500/30" />

            <div className="flex justify-between text-lg font-bold text-primary-700">
              <span>Total</span>
              <span>{formatINR(breakdown.total)}</span>
            </div>
          </div>

          <PickupSlotSelector
            restaurantId={items[0]?.restaurantId ?? ""}
            selectedSlot={pickupSlot}
            onSelect={setPickupSlot}
          />

          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handlePlaceOrder}
            disabled={step === "creating"}
            className="w-full min-h-[44px] rounded-full bg-primary-500 py-3.5 text-base font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {step === "creating"
              ? "Creating Order..."
              : `Place Pickup Order (${formatINR(breakdown.total)})`}
          </button>

          <button
            type="button"
            onClick={() => router.push("/")}
            className="w-full py-2 text-sm text-neutral-400 hover:text-primary-600"
          >
            Add More Items
          </button>
        </div>
      )}
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <AuthGate>
      <CheckoutContent />
    </AuthGate>
  );
}
