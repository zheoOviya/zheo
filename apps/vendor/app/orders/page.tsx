"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { m, AnimatePresence } from "framer-motion";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  fetchOrders,
  advanceOrder,
  confirmPickup,
  cancelOrder,
  type VendorOrder,
  type OrderStatus,
  type PaymentMethod,
} from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { useOrdersWebSocket } from "@/hooks/useOrdersWebSocket";
import { isPickupOtpComplete, sanitizePickupOtp, pickupFailureMessage } from "@/lib/kds";
import { ORDER_STATUS_META } from "@/lib/status";
import {
  formatINR,
  formatDateTime,
  formatTime,
  relativeTime,
  shortOrderId,
  isSameDay,
} from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  PaymentBadge,
  FilterChip,
  ErrorBanner,
  Spinner,
  EmptyPanel,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui";

const STATUS_FILTERS: { label: string; value: "all" | OrderStatus }[] = [
  { label: "All", value: "all" },
  { label: "New", value: "CONFIRMED" },
  { label: "Preparing", value: "PREPARING" },
  { label: "Ready", value: "READY_FOR_PICKUP" },
  { label: "Picked Up", value: "PICKED_UP" },
  { label: "Pending Payment", value: "PAYMENT_PENDING" },
  { label: "Payment Failed", value: "PAYMENT_FAILED" },
  { label: "Cancelled", value: "CANCELLED" },
];

const PAYMENT_FILTERS: { label: string; value: "all" | PaymentMethod | "unpaid" }[] = [
  { label: "All", value: "all" },
  { label: "COD", value: "cod" },
  { label: "UPI", value: "upi" },
  { label: "Card", value: "card" },
  { label: "NetBanking", value: "netbanking" },
  { label: "Wallet", value: "wallet" },
  { label: "Unpaid", value: "unpaid" },
];

const ADVANCE_ACTION: Partial<Record<OrderStatus, { label: string; next: string }>> = {
  CONFIRMED: { label: "Start Preparing", next: "Preparing" },
  PREPARING: { label: "Mark Almost Ready", next: "Almost Ready" },
  ALMOST_READY: { label: "Mark Ready", next: "Ready for pickup" },
};

const CANCELLABLE: OrderStatus[] = ["DRAFT", "PAYMENT_PENDING", "CONFIRMED", "PREPARING"];

export default function OrdersPage() {
  const [orders, setOrders] = useState<VendorOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | OrderStatus>("all");
  const [paymentFilter, setPaymentFilter] = useState<"all" | PaymentMethod | "unpaid">("all");
  const [todayOnly, setTodayOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState("");
  const [otpError, setOtpError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(30);

  const { activeRestaurantId } = useActiveRestaurant();
  const { updates } = useOrdersWebSocket(activeRestaurantId);

  useEffect(() => {
    if (!activeRestaurantId) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await fetchOrders({ scope: "all" }, activeRestaurantId);
        if (!cancelled) setOrders(all);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load orders");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeRestaurantId]);

  useEffect(() => {
    if (updates.length === 0) return;
    const latest = updates[0];
    if (!latest) return;
    setOrders((prev) =>
      prev.map((o) =>
        o.id === latest.data.order_id ? { ...o, status: latest.data.sql_status as OrderStatus } : o,
      ),
    );
  }, [updates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders
      .filter((o) => {
        if (statusFilter !== "all" && o.status !== statusFilter) return false;
        if (todayOnly && !isSameDay(o.created_at)) return false;
        if (paymentFilter === "unpaid" && o.payment_method) return false;
        if (
          paymentFilter !== "all" &&
          paymentFilter !== "unpaid" &&
          o.payment_method !== paymentFilter
        ) {
          return false;
        }
        if (q) {
          const haystack = [
            o.id,
            shortOrderId(o.id),
            o.customer_phone ?? "",
            ...o.items.map((i) => i.name),
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [orders, statusFilter, paymentFilter, todayOnly, search]);

  const visible = filtered.slice(0, visibleCount);

  const selected = selectedId ? (orders.find((o) => o.id === selectedId) ?? null) : null;

  const hasActiveFilters =
    statusFilter !== "all" || paymentFilter !== "all" || todayOnly || search.trim() !== "";

  function clearFilters() {
    setStatusFilter("all");
    setPaymentFilter("all");
    setTodayOnly(false);
    setSearch("");
    setVisibleCount(30);
  }

  async function handleAdvance(order: VendorOrder) {
    setBusy(order.id);
    setError("");
    try {
      const result = await advanceOrder(order.id);
      setOrders((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, status: result.status } : o)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance the order");
    } finally {
      setBusy(null);
    }
  }

  async function handleHandOver(order: VendorOrder) {
    if (!isPickupOtpComplete(otpInput)) return;
    setBusy(order.id);
    setOtpError("");
    try {
      await confirmPickup(order.id, otpInput);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: "PICKED_UP" } : o)));
      setOtpInput("");
      setSelectedId(null);
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : pickupFailureMessage(undefined));
      setOtpInput("");
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel(order: VendorOrder) {
    setBusy(order.id);
    setError("");
    try {
      await cancelOrder(order.id);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: "CANCELLED" } : o)));
      setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the order");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        subtitle="Every order for this restaurant, searchable and filterable"
      />

      <ErrorBanner message={error} />

      <SectionCard>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((f) => {
              const count =
                f.value === "all"
                  ? orders.length
                  : orders.filter((o) => o.status === f.value).length;
              return (
                <FilterChip
                  key={f.value}
                  label={f.label}
                  count={count}
                  active={statusFilter === f.value}
                  onClick={() => setStatusFilter(f.value)}
                />
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {PAYMENT_FILTERS.map((f) => (
              <FilterChip
                key={f.value}
                label={f.label}
                active={paymentFilter === f.value}
                onClick={() => setPaymentFilter(f.value)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="order-search">
              Search orders
            </label>
            <div className="relative min-w-[220px] flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                <MagnifyingGlassIcon className="h-4 w-4" />
              </span>
              <input
                id="order-search"
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setVisibleCount(30);
                }}
                placeholder="Search by order #, phone or item"
                className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
              />
            </div>
            <FilterChip label="Today" active={todayOnly} onClick={() => setTodayOnly((v) => !v)} />
          </div>
        </div>
      </SectionCard>

      {orders.length === 0 ? (
        <EmptyPanel
          title="No orders yet"
          description="Place a test order from the SnakZap consumer app and it will show up here."
        />
      ) : filtered.length === 0 ? (
        <EmptyPanel
          title="No orders match your filters"
          description="Try different filters, or clear them to see every order."
          cta={<SecondaryButton onClick={clearFilters}>Clear filters</SecondaryButton>}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-sm text-slate-500">
            <p>
              Showing <span className="font-semibold text-slate-700">{visible.length}</span> of{" "}
              <span className="font-semibold text-slate-700">{filtered.length}</span> orders
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="font-semibold text-teal-600 hover:text-teal-700"
              >
                Clear filters
              </button>
            )}
          </div>
          <SectionCard>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-4 font-semibold">Order</th>
                    <th className="py-2 pr-4 font-semibold">Placed</th>
                    <th className="py-2 pr-4 font-semibold">Customer</th>
                    <th className="py-2 pr-4 font-semibold">Items</th>
                    <th className="py-2 pr-4 font-semibold">Payment</th>
                    <th className="py-2 pr-4 text-right font-semibold">Total</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {visible.map((o) => (
                    <tr
                      key={o.id}
                      className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                        selectedId === o.id ? "bg-teal-50/60" : ""
                      }`}
                      onClick={() => {
                        setSelectedId(o.id === selectedId ? null : o.id);
                        setOtpInput("");
                        setOtpError("");
                      }}
                    >
                      <td className="py-3 pr-4">
                        <span className="font-mono font-bold text-slate-800">
                          #{shortOrderId(o.id)}
                        </span>
                        <span className="ml-2 hidden text-xs text-slate-400 lg:inline">
                          {o.is_catering ? "Catering" : "Pickup"}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {formatTime(o.created_at)}
                        <span className="block text-xs text-slate-400">
                          {relativeTime(o.created_at)}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {o.customer_phone ? (
                          <span className="font-medium">{o.customer_phone}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        {o.checked_in && (
                          <span className="ml-2 text-xs font-semibold text-emerald-600">Here</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-slate-600">
                        {o.items.reduce((n, i) => n + i.quantity, 0)} item
                        {o.items.reduce((n, i) => n + i.quantity, 0) !== 1 ? "s" : ""}
                      </td>
                      <td className="py-3 pr-4">
                        <PaymentBadge method={o.payment_method} />
                      </td>
                      <td className="py-3 pr-4 text-right font-semibold tabular-nums text-slate-800">
                        {formatINR(o.total_amount)}
                      </td>
                      <td className="py-3">
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > visibleCount && (
              <div className="mt-3 flex justify-center">
                <SecondaryButton onClick={() => setVisibleCount((n) => n + 30)}>
                  Show more ({filtered.length - visibleCount} more)
                </SecondaryButton>
              </div>
            )}
          </SectionCard>
        </>
      )}

      <AnimatePresence>
        {selected && (
          <OrderDetailPanel
            key={selected.id}
            order={selected}
            busy={busy}
            otpInput={otpInput}
            setOtpInput={setOtpInput}
            otpError={otpError}
            onClose={() => setSelectedId(null)}
            onAdvance={() => handleAdvance(selected)}
            onHandOver={() => handleHandOver(selected)}
            onCancel={() => handleCancel(selected)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function OrderDetailPanel({
  order,
  busy,
  otpInput,
  setOtpInput,
  otpError,
  onClose,
  onAdvance,
  onHandOver,
  onCancel,
}: {
  order: VendorOrder;
  busy: string | null;
  otpInput: string;
  setOtpInput: (v: string) => void;
  otpError: string;
  onClose: () => void;
  onAdvance: () => void;
  onHandOver: () => void;
  onCancel: () => void;
}) {
  const advance = ADVANCE_ACTION[order.status];
  const cancellable = CANCELLABLE.includes(order.status);
  const isWorking = busy === order.id;
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";

    if (panel) {
      const first = panel.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel).focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey) {
        if (document.activeElement === first || !panel.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40">
      <m.div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <m.aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Order #${shortOrderId(order.id)} details`}
        tabIndex={-1}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "tween", duration: 0.25, ease: "easeOut" }}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900">#{shortOrderId(order.id)}</h2>
              <StatusBadge status={order.status} />
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              {order.is_catering ? "Catering order" : "Pickup order"} · placed{" "}
              {formatDateTime(order.created_at)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close order details"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {otpError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {otpError}
            </div>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Items
            </h3>
            <ul className="space-y-2">
              {order.items.map((item, idx) => (
                <li
                  key={`${item.name}-${idx}`}
                  className="rounded-lg border border-slate-100 px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-800">
                      <span className="mr-1.5 text-slate-400">x{item.quantity}</span>
                      {item.name}
                    </p>
                    <span className="text-sm font-semibold tabular-nums text-slate-700">
                      {formatINR(item.base_price * item.quantity)}
                    </span>
                  </div>
                  {item.customizations.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {item.customizations.map((c) => (
                        <li key={c.name} className="flex justify-between text-xs text-slate-500">
                          <span>+ {c.name}</span>
                          <span className="tabular-nums">
                            {c.price_delta > 0
                              ? `+${formatINR(c.price_delta)}`
                              : formatINR(c.price_delta)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2">
              <span className="text-sm font-semibold text-slate-700">Total</span>
              <span className="text-base font-bold tabular-nums text-slate-900">
                {formatINR(order.total_amount)}
              </span>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">Payment</p>
              <div className="mt-1">
                <PaymentBadge method={order.payment_method} />
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">Customer</p>
              <p className="mt-1 text-sm font-medium text-slate-800">
                {order.customer_phone ?? "—"}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">Pickup slot</p>
              <p className="mt-1 text-sm font-medium text-slate-800">
                {order.scheduled_pickup_time ? formatDateTime(order.scheduled_pickup_time) : "ASAP"}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-xs text-slate-500">Status</p>
              <p className="mt-1 text-sm font-medium text-slate-800">
                {ORDER_STATUS_META[order.status].label}
              </p>
            </div>
          </section>

          {order.status === "READY_FOR_PICKUP" && order.pickup_otp && (
            <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs font-semibold text-emerald-700">Pickup code</p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-[0.3em] text-emerald-700">
                {order.pickup_otp}
              </p>
              <div className="mt-3 space-y-2">
                <label className="sr-only" htmlFor={`handover-${order.id}`}>
                  Enter the customer's pickup OTP
                </label>
                <input
                  id={`handover-${order.id}`}
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="Enter customer OTP"
                  value={otpInput}
                  onChange={(e) => setOtpInput(sanitizePickupOtp(e.target.value))}
                  className="min-h-[44px] w-full rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm tracking-widest text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
                <PrimaryButton
                  onClick={onHandOver}
                  disabled={!isPickupOtpComplete(otpInput) || isWorking}
                  className="w-full bg-emerald-600 hover:bg-emerald-700"
                >
                  {isWorking ? "Handing over..." : "Confirm Pickup"}
                </PrimaryButton>
              </div>
            </section>
          )}

          <div className="space-y-2 pt-1">
            {advance && (
              <PrimaryButton onClick={onAdvance} disabled={isWorking} className="w-full">
                {isWorking ? "Updating..." : `${advance.label} → ${advance.next}`}
              </PrimaryButton>
            )}
            {cancellable && (
              confirmingCancel ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={isWorking}
                    className="min-h-[40px] w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                  >
                    {isWorking ? "Cancelling..." : "Confirm cancel?"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingCancel(false)}
                    className="w-full py-1 text-sm text-slate-400 hover:text-slate-600"
                  >
                    Keep order
                  </button>
                </div>
              ) : (
                <SecondaryButton
                  onClick={() => setConfirmingCancel(true)}
                  disabled={isWorking}
                  className="w-full border-red-200 text-red-600 hover:bg-red-50"
                >
                  Cancel Order
                </SecondaryButton>
              )
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2 text-sm text-slate-400 hover:text-slate-600"
            >
              Close
            </button>
          </div>
        </div>
      </m.aside>
    </div>
  );
}
