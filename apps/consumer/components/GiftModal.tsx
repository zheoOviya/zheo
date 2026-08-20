"use client";

import { useState } from "react";
import { GiftIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { createGift, simulatePaymentWebhook, type Gift, type MenuItem } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { loadRazorpayScript, createRazorpayInstance } from "@/lib/razorpay";
import { formatINR } from "@/lib/pricing";
import { GiftSuccess } from "./GiftSuccess";

export default function GiftModal({
  restaurantId,
  item,
  customizations,
  onPaid,
  onClose,
}: {
  restaurantId: string;
  item: MenuItem;
  customizations: { name: string; price_delta: number }[];
  onPaid: (gift: Gift) => void;
  onClose: () => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [paidGift, setPaidGift] = useState<Gift | null>(null);

  const customizationTotal = customizations.reduce((s, c) => s + c.price_delta, 0);
  const amount = item.price + customizationTotal;

  async function handlePay() {
    if (!accessToken) return;
    setError("");
    setPaying(true);
    try {
      const result = await createGift(accessToken, {
        restaurant_id: restaurantId,
        menu_item_id: item.id,
        customizations,
        message: message.trim() || undefined,
        recipient_name: recipientName.trim() || undefined,
      });

      const loaded = await loadRazorpayScript();
      if (!loaded) {
        setError("Failed to load payment gateway");
        setPaying(false);
        return;
      }

      const rzp = createRazorpayInstance({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_placeholder",
        amount: result.amount * 100,
        currency: "INR",
        name: "SnakZap",
        description: `Gift: ${item.name}`,
        order_id: result.razorpay_order_id,
        prefill: { contact: user?.phone || "" },
        theme: { color: "#0D9488" },
        handler: async () => {
          try {
            await simulatePaymentWebhook(result.razorpay_order_id, result.amount, true);
            setPaidGift(result.gift);
            onPaid(result.gift);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Payment verification failed");
            setPaying(false);
          }
        },
        modal: { ondismiss: () => setPaying(false) },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create gift");
      setPaying(false);
    }
  }

  if (paidGift) {
    return <GiftSuccess gift={paidGift} onClose={onClose} />;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" onClick={onClose}>
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Gift this item"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-elevation-3 dark:bg-neutral-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-500/10">
              <GiftIcon className="h-5 w-5 text-primary-600" />
            </span>
            <h2 className="text-lg font-bold text-neutral-900 dark:text-white">Gift this item</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-xl bg-neutral-50 p-4 dark:bg-neutral-800/60">
          <p className="text-sm font-bold text-neutral-800 dark:text-neutral-100">{item.name}</p>
          {customizations.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {customizations.map((c) => `${c.name} (+${formatINR(c.price_delta)})`).join(", ")}
            </p>
          )}
          <p className="mt-2 text-lg font-extrabold text-primary-700 dark:text-primary-300">
            {formatINR(amount)}
          </p>
        </div>

        <label className="mt-4 block">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
            Recipient name (optional)
          </span>
          <input
            type="text"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            placeholder="Who is this for?"
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={280}
            rows={2}
            placeholder="Say something nice..."
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={paying}
          onClick={handlePay}
          className="mt-5 min-h-[44px] w-full rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm disabled:opacity-50"
        >
          {paying ? "Opening payment..." : `Pay & Send (${formatINR(amount)})`}
        </button>
      </div>
    </div>
  );
}
