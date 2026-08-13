import type { OrderStatus, PaymentMethod } from "./api";

// ============================================
// Shared display metadata for order statuses and
// payment methods so every page renders them the
// same way.
// ============================================

export const ORDER_STATUS_META: Record<OrderStatus, { label: string; badge: string; dot: string }> =
  {
    DRAFT: {
      label: "Draft",
      badge: "bg-slate-100 text-slate-600 ring-slate-200",
      dot: "bg-slate-400",
    },
    PAYMENT_PENDING: {
      label: "Payment Pending",
      badge: "bg-amber-50 text-amber-700 ring-amber-200",
      dot: "bg-amber-500",
    },
    CONFIRMED: {
      label: "New Order",
      badge: "bg-teal-50 text-teal-700 ring-teal-200",
      dot: "bg-teal-500",
    },
    PREPARING: {
      label: "Preparing",
      badge: "bg-blue-50 text-blue-700 ring-blue-200",
      dot: "bg-blue-500",
    },
    ALMOST_READY: {
      label: "Almost Ready",
      badge: "bg-orange-50 text-orange-700 ring-orange-200",
      dot: "bg-orange-500",
    },
    READY_FOR_PICKUP: {
      label: "Ready for Pickup",
      badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
      dot: "bg-emerald-500",
    },
    PICKED_UP: {
      label: "Picked Up",
      badge: "bg-slate-100 text-slate-600 ring-slate-200",
      dot: "bg-slate-400",
    },
    CANCELLED: {
      label: "Cancelled",
      badge: "bg-red-50 text-red-700 ring-red-200",
      dot: "bg-red-500",
    },
    REFUNDED: {
      label: "Refunded",
      badge: "bg-red-50 text-red-700 ring-red-200",
      dot: "bg-red-400",
    },
    PAYMENT_FAILED: {
      label: "Payment Failed",
      badge: "bg-red-50 text-red-700 ring-red-200",
      dot: "bg-red-500",
    },
    EXPIRED: {
      label: "Expired",
      badge: "bg-slate-100 text-slate-600 ring-slate-200",
      dot: "bg-slate-400",
    },
    DISPUTED: {
      label: "Disputed",
      badge: "bg-red-50 text-red-700 ring-red-200",
      dot: "bg-red-500",
    },
    SETTLED: {
      label: "Settled",
      badge: "bg-slate-100 text-slate-600 ring-slate-200",
      dot: "bg-slate-400",
    },
  };

export const PAYMENT_METHOD_META: Record<
  Exclude<PaymentMethod, null>,
  { label: string; short: string; badge: string }
> = {
  upi: { label: "UPI", short: "UPI", badge: "bg-violet-50 text-violet-700 ring-violet-200" },
  card: { label: "Card", short: "Card", badge: "bg-sky-50 text-sky-700 ring-sky-200" },
  netbanking: {
    label: "Net Banking",
    short: "NetBank",
    badge: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  },
  wallet: {
    label: "Wallet",
    short: "Wallet",
    badge: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  },
  cod: {
    label: "Cash on Pickup",
    short: "COD",
    badge: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  },
};

export function paymentMeta(method: PaymentMethod) {
  if (!method)
    return { label: "Unpaid", short: "—", badge: "bg-slate-50 text-slate-400 ring-slate-200" };
  return PAYMENT_METHOD_META[method];
}

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
];
