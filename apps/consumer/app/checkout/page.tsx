"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { useAuthStore } from "@/lib/store";
import { useCartStore } from "@/lib/store";
import { createPaymentOrder, simulatePaymentWebhook } from "@/lib/api";
import { computePriceBreakdown, formatINR } from "@/lib/pricing";

type CheckoutStep = "cart" | "creating" | "payment" | "success" | "failed";

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

  async function handlePlaceOrder() {
    if (!accessToken) return;
    setStep("creating");
    setError("");

    try {
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
      <main className="mx-auto max-w-5xl px-4 py-6">
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
            className="mt-6 rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Back to Home
          </button>
        </div>
      </main>
    );
  }

  if (step === "failed") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
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
            className="mt-6 rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Try Again
          </button>
        </div>
      </main>
    );
  }

  if (step === "payment" && rpOrderId) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-primary-700">Checkout</h1>
        </header>
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-neutral-700">Simulate Razorpay Payment</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Razorpay Order: {rpOrderId}
          </p>
          <p className="mt-1 text-lg font-bold text-primary-700">
            {formatINR(amount)}
          </p>

          <p className="mt-6 text-sm text-neutral-500">
            In production, the Razorpay Checkout SDK (UPI, cards, netbanking)
            would open here. Select an outcome to simulate:
          </p>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => handleSimulatePayment(true)}
              disabled={processing}
              className="flex-1 rounded-full bg-primary-500 py-3 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {processing ? "Processing..." : "Simulate Success"}
            </button>
            <button
              type="button"
              onClick={() => handleSimulatePayment(false)}
              disabled={processing}
              className="flex-1 rounded-full border border-red-400 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Simulate Failure
            </button>
          </div>

          {error && (
            <p className="mt-4 rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
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
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-lg font-medium text-neutral-600">
            Your cart is empty
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mt-4 rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Browse Restaurants
          </button>
        </div>
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

          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handlePlaceOrder}
            disabled={step === "creating"}
            className="w-full rounded-full bg-primary-500 py-3.5 text-base font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
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
