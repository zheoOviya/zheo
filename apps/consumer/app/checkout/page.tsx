"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CheckIcon, XMarkIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { useAuthStore } from "@/lib/store";
import { useCartStore } from "@/lib/store";
import {
  createPaymentOrder,
  invalidateLoyaltyCachesAfterOrder,
  simulatePaymentWebhook,
  type PaymentMethod,
} from "@/lib/api";
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

const PAYMENT_METHODS: {
  id: PaymentMethod;
  label: string;
  description: string;
  recommended?: boolean;
}[] = [
  {
    id: "upi",
    label: "UPI",
    description: "GPay, PhonePe, Paytm & more",
    recommended: true,
  },
  {
    id: "card",
    label: "Card",
    description: "Credit, Debit & RuPay cards",
  },
  {
    id: "netbanking",
    label: "Net Banking",
    description: "All major banks",
  },
  {
    id: "wallet",
    label: "Wallets",
    description: "Paytm, Amazon Pay & more",
  },
  {
    id: "cod",
    label: "Cash on Pickup",
    description: "Pay at the counter when you pick up",
  },
];

function PaymentMethodSelector({
  value,
  onChange,
}: {
  value: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
}) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-lg font-semibold text-neutral-700">Payment Method</h2>
      <p className="mb-4 text-sm text-neutral-500">Choose how you want to pay for your order.</p>
      <div role="radiogroup" aria-label="Payment method selection" className="space-y-2">
        {PAYMENT_METHODS.map((m) => {
          const selected = value === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(m.id)}
              className={`flex w-full items-center gap-3 rounded-xl border-2 p-4 text-left transition-colors ${
                selected
                  ? "border-primary-500 bg-primary-500/5"
                  : "border-primary-500/15 bg-white hover:border-primary-500/40"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected ? "border-primary-500" : "border-neutral-300"
                }`}
              >
                {selected && <span className="h-2.5 w-2.5 rounded-full bg-primary-500" />}
              </span>
              <span>
                <span className="block text-sm font-semibold text-neutral-800">
                  {m.label}
                  {m.recommended && (
                    <span className="ml-2 rounded-full bg-primary-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-700">
                      Recommended
                    </span>
                  )}
                </span>
                <span className="block text-xs text-neutral-500">{m.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
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
      const res = await fetch(`/api/v1/restaurants/${restaurantId}/pickup-slots?date=${today}`);
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
      setFocusedIndex((prev) => (prev - 1 + enabledSlots.length) % enabledSlots.length);
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
      <h2 className="mb-4 text-lg font-semibold text-neutral-700">Pickup Time</h2>

      <div role="radiogroup" aria-label="Pickup time selection" onKeyDown={handleKeyDown}>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-primary-500/20 p-4">
          <input
            type="radio"
            name="pickup_slot"
            className="h-4 w-4 accent-primary-500"
            checked={selectedSlot === null}
            onChange={() => {
              setShowGrid(false);
              onSelect(null);
            }}
          />
          <div>
            <p className="text-sm font-semibold text-neutral-700">ASAP (~15 min)</p>
            <p className="text-xs text-neutral-400">Pick up as soon as it is ready</p>
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
              <p className="text-sm font-semibold text-neutral-700">Schedule for later</p>
              <p className="text-xs text-neutral-400">Choose a specific pickup time</p>
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
                  {slots.map((slot) => {
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
                        {!slot.available && <div className="mt-0.5 text-2xs">Full</div>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {selectedSlot && (
            <p className="mt-2 text-xs text-primary-600">Pickup at: {selectedSlot}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckoutContent() {
  const router = useRouter();
  const { user, accessToken } = useAuthStore();
  const { items, clear } = useCartStore();
  const breakdown = computePriceBreakdown(items);

  const [step, setStep] = useState<CheckoutStep>("cart");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [rpOrderId, setRpOrderId] = useState<string | null>(null);
  const [amount, setAmount] = useState<number>(0);
  const [error, setError] = useState("");
  const [processing, setProcessing] = useState(false);
  const [pickupSlot, setPickupSlot] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("upi");
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
        handler: async () => {
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
            ...(item.giftId ? { gift_id: item.giftId } : {}),
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
      invalidateLoyaltyCachesAfterOrder();

      const payment = await createPaymentOrder(createdOrderId, accessToken, paymentMethod);

      if (payment.payment_method === "cod") {
        setAmount(payment.amount);
        clear();
        setStep("success");
        return;
      }

      setRpOrderId(payment.razorpay_order_id ?? null);
      setAmount(payment.amount);
      setStep("payment");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStep("cart");
    }
  }

  if (step === "success") {
    return (
      <main className="py-6">
        <AppHeader />
        <header className="mb-6">
          <p className="section-eyebrow">Secure checkout</p>
          <h1 className="section-title">Checkout</h1>
        </header>
        <div className="surface-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary-500/10">
            <CheckIcon className="h-8 w-8 text-primary-500" />
          </div>
          <h2 className="text-xl font-semibold text-neutral-700 dark:text-neutral-100">
            Order Confirmed!
          </h2>
          {orderId && (
            <p className="mt-2 text-sm text-neutral-500">
              Order #
              <span className="font-mono font-semibold text-primary-700">
                {orderId.slice(-6).toUpperCase()}
              </span>
            </p>
          )}
          {paymentMethod === "cod" ? (
            <>
              <p className="mt-2 text-sm text-neutral-500">
                Please pay{" "}
                <span className="font-semibold text-primary-700">{formatINR(amount)}</span> in cash
                at the pickup counter.
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                You will receive a pickup OTP when your order is ready.
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-neutral-500">
                Your order has been placed and payment is being processed.
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                You will receive a pickup OTP when your order is ready.
              </p>
            </>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {orderId && (
              <Link
                href={`/orders/${orderId}`}
                className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
              >
                Track Order →
              </Link>
            )}
            <button
              type="button"
              onClick={() => router.push("/")}
              className="min-h-[44px] rounded-full border border-primary-500/30 px-6 py-2.5 text-sm font-semibold text-primary-700 hover:bg-surface-light dark:text-primary-400"
            >
              Back to Home
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (step === "failed") {
    return (
      <main className="py-6">
        <AppHeader />
        <header className="mb-6">
          <p className="section-eyebrow">Secure checkout</p>
          <h1 className="section-title">Checkout</h1>
        </header>
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <XMarkIcon className="h-8 w-8 text-red-500" />
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
        <AppHeader />
        <header className="mb-6">
          <p className="section-eyebrow">Secure checkout</p>
          <h1 className="section-title">Checkout</h1>
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
    <main className="py-6 pb-28">
      <AppHeader />
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="section-eyebrow">Secure checkout</p>
          <h1 className="section-title">Checkout</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {user?.phone ? `Signed in as +91 ${user.phone}` : "Preparing your order"}
          </p>
        </div>
      </header>

      {items.length === 0 ? (
        <EmptyState
          icon={
            <ShoppingBagIcon className="h-10 w-10 text-primary-500" />
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
                const customTotal = item.customizations.reduce((s, c) => s + c.price_delta, 0);
                const unitPrice = item.basePrice + customTotal;
                return (
                  <li key={item.menuItemId} className="flex justify-between text-sm">
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

          <PaymentMethodSelector value={paymentMethod} onChange={setPaymentMethod} />

          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">{error}</p>
          )}

          <button
            type="button"
            onClick={handlePlaceOrder}
            disabled={step === "creating"}
            className="w-full min-h-[44px] rounded-full bg-primary-500 py-3.5 text-base font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {step === "creating"
              ? "Creating Order..."
              : paymentMethod === "cod"
                ? `Place Pickup Order (${formatINR(breakdown.total)}) — Pay at Counter`
                : `Place Pickup Order & Pay (${formatINR(breakdown.total)})`}
          </button>

          <button
            type="button"
            onClick={() => router.push("/")}
            className="w-full py-2 text-sm text-neutral-400 hover:text-primary-600"
          >
            Continue Shopping
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
