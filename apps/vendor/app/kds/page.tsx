"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { m, AnimatePresence } from "framer-motion";
import { Badge, CountdownTimer, EmptyState } from "@snakzap/ui";
import {
  fetchOrders,
  advanceOrder,
  confirmPickup,
  type VendorOrder,
  type OrderStatus,
} from "@/lib/api";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { useOrdersWebSocket } from "@/hooks/useOrdersWebSocket";
import { isPickupOtpComplete, pickupFailureMessage, sanitizePickupOtp } from "@/lib/kds";
import { formatINR, formatTime, shortOrderId } from "@/lib/format";
import { PaymentBadge, Spinner, ErrorBanner } from "@/components/ui";

interface ColumnConfig {
  status: OrderStatus;
  title: string;
  prepSeconds: number;
}

const COLUMNS: ColumnConfig[] = [
  { status: "CONFIRMED", title: "New Orders", prepSeconds: 600 },
  { status: "PREPARING", title: "Preparing", prepSeconds: 480 },
  { status: "ALMOST_READY", title: "Almost Ready", prepSeconds: 120 },
  { status: "READY_FOR_PICKUP", title: "Ready for Pickup", prepSeconds: 300 },
];

const STATUS_ADVANCE: Partial<Record<OrderStatus, { next: OrderStatus; label: string }>> = {
  CONFIRMED: { next: "PREPARING", label: "Start" },
  PREPARING: { next: "ALMOST_READY", label: "Almost Ready" },
  ALMOST_READY: { next: "READY_FOR_PICKUP", label: "Mark Ready" },
};

function timeElapsed(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

function urgencyMeta(elapsed: number, max: number) {
  const pct = max > 0 ? elapsed / max : 0;
  if (pct < 0.3)
    return {
      border: "border-l-emerald-400",
      bg: "bg-emerald-50/40",
      label: "On time",
      text: "text-emerald-600",
    };
  if (pct < 0.7)
    return {
      border: "border-l-amber-400",
      bg: "bg-amber-50/40",
      label: "Running late",
      text: "text-amber-600",
    };
  return {
    border: "border-l-red-400",
    bg: "bg-red-50/40",
    label: "Urgent",
    text: "text-red-600",
  };
}

export default function KdsPage() {
  const [orders, setOrders] = useState<VendorOrder[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [otpInput, setOtpInput] = useState<Record<string, string>>({});
  const [otpError, setOtpError] = useState<Record<string, string>>({});
  const [handingOver, setHandingOver] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const { activeRestaurantId } = useActiveRestaurant();
  const { updates, connected } = useOrdersWebSocket(activeRestaurantId);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadOrders = useCallback(async () => {
    if (!activeRestaurantId) return;
    try {
      const data = await fetchOrders({ scope: "active" }, activeRestaurantId);
      setOrders(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
      setLoading(false);
    }
  }, [activeRestaurantId]);

  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 15_000);
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadOrders]);

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

  async function handleAdvance(order: VendorOrder) {
    setError("");
    try {
      const result = await advanceOrder(order.id);
      setOrders((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, status: result.status } : o)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance the order.");
    }
  }

  async function handleHandOver(order: VendorOrder) {
    const otp = otpInput[order.id];
    if (!isPickupOtpComplete(otp)) return;

    setHandingOver((p) => ({ ...p, [order.id]: true }));
    setOtpError((p) => ({ ...p, [order.id]: "" }));
    try {
      await confirmPickup(order.id, otp ?? "");
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setOtpInput((p) => {
        const next = { ...p };
        delete next[order.id];
        return next;
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setOtpError((p) => ({
        ...p,
        [order.id]: pickupFailureMessage(code, err instanceof Error ? err.message : undefined),
      }));
      setOtpInput((p) => ({ ...p, [order.id]: "" }));
    } finally {
      setHandingOver((p) => {
        const next = { ...p };
        delete next[order.id];
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-3.5rem)] flex-col bg-slate-100 sm:-mx-6 sm:-my-6 lg:-mx-8">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Kitchen Display</h1>
          <p className="text-xs text-slate-500" aria-live="polite">
            {orders.length} active orders
            <span
              className={`ml-2 inline-block h-2 w-2 rounded-full ${
                connected ? "bg-emerald-500" : "bg-red-500"
              }`}
              aria-hidden="true"
            />
            <span className="ml-1">{connected ? "Live" : "Offline"}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/orders"
            className="hidden text-sm font-semibold text-teal-600 hover:text-teal-700 sm:inline"
          >
            Orders →
          </Link>
          <span className="font-mono text-sm tabular-nums text-slate-500">
            {new Date(now).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      </header>

      <ErrorBanner message={error} />

      <div className="flex-1 overflow-y-auto">
        <div className="grid h-full grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const colOrders = orders.filter((o) => o.status === col.status);

            return (
              <div
                key={col.status}
                className="flex min-h-0 min-w-0 flex-col rounded-xl border border-slate-200 bg-white"
              >
                <div className="flex items-center justify-between border-b border-slate-100 p-3">
                  <h2 className="text-sm font-bold text-slate-700">{col.title}</h2>
                  <Badge variant="default" size="sm">
                    {colOrders.length}
                  </Badge>
                </div>

                <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-2" role="list">
                  <AnimatePresence mode="popLayout">
                    {colOrders.map((order) => {
                      const elapsed = timeElapsed(order.created_at);
                      const urgency = urgencyMeta(elapsed, col.prepSeconds);
                      const advance = STATUS_ADVANCE[col.status];
                      const isReady = col.status === "READY_FOR_PICKUP";

                      return (
                        <m.div
                          key={order.id}
                          layout
                          role="listitem"
                          aria-label={`Order #${shortOrderId(order.id)}, ${col.title.toLowerCase()}, ${urgency.label}`}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{ duration: 0.2 }}
                          className={`flex flex-col justify-between rounded-xl border border-l-4 border-slate-200 p-3 ${urgency.border} ${urgency.bg}`}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <p className="font-mono text-base font-bold text-slate-900">
                                #{shortOrderId(order.id)}
                              </p>
                              <span
                                className={`mt-0.5 block text-[11px] font-medium ${urgency.text}`}
                              >
                                {urgency.label}
                              </span>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <PaymentBadge method={order.payment_method} />
                              <CountdownTimer targetSeconds={col.prepSeconds} />
                            </div>
                          </div>

                          <ul className="flex-1 space-y-1 pt-2">
                            {order.items.map((item) => (
                              <li
                                key={`${order.id}-${item.name}`}
                                className="flex justify-between text-sm"
                              >
                                <span className="text-slate-700">{item.name}</span>
                                <span className="font-mono text-slate-500">x{item.quantity}</span>
                              </li>
                            ))}
                          </ul>

                          <p className="mt-2 text-[11px] text-slate-400">
                            {formatINR(order.total_amount)} · {formatTime(order.created_at)}
                            {order.checked_in && (
                              <span className="ml-1 font-semibold text-emerald-600">· Here</span>
                            )}
                          </p>

                          {advance ? (
                            <button
                              type="button"
                              onClick={() => handleAdvance(order)}
                              aria-label={`Advance order #${shortOrderId(order.id)} from ${col.title}`}
                              className="mt-2 min-h-[40px] w-full rounded-lg bg-teal-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-teal-700 active:scale-[0.98]"
                            >
                              {advance.label} →
                            </button>
                          ) : isReady ? (
                            <div className="mt-2 space-y-2">
                              {order.pickup_otp && (
                                <p className="text-center text-xs text-slate-500">
                                  Code:{" "}
                                  <span className="font-mono text-lg font-bold tracking-widest text-teal-700">
                                    {order.pickup_otp}
                                  </span>
                                </p>
                              )}
                              <label className="sr-only" htmlFor={`otp-${order.id}`}>
                                Pickup OTP for order #{shortOrderId(order.id)}
                              </label>
                              <input
                                id={`otp-${order.id}`}
                                type="text"
                                inputMode="numeric"
                                maxLength={4}
                                placeholder="Enter OTP"
                                value={otpInput[order.id] ?? ""}
                                onChange={(e) => {
                                  const value = sanitizePickupOtp(e.target.value);
                                  setOtpInput((p) => ({ ...p, [order.id]: value }));
                                  if (otpError[order.id]) {
                                    setOtpError((p) => ({ ...p, [order.id]: "" }));
                                  }
                                }}
                                className="min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-sm tracking-widest text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                              />
                              {otpError[order.id] && (
                                <p role="alert" className="text-xs text-red-600">
                                  {otpError[order.id]}
                                </p>
                              )}
                              <button
                                type="button"
                                onClick={() => handleHandOver(order)}
                                disabled={
                                  !isPickupOtpComplete(otpInput[order.id]) || handingOver[order.id]
                                }
                                aria-label={`Hand over order #${shortOrderId(order.id)}`}
                                className="min-h-[40px] w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-700 disabled:opacity-30"
                              >
                                {handingOver[order.id] ? "Handing over..." : "Hand Over"}
                              </button>
                            </div>
                          ) : null}
                        </m.div>
                      );
                    })}
                  </AnimatePresence>

                  {colOrders.length === 0 && (
                    <EmptyState
                      icon={
                        <svg
                          className="h-8 w-8"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-3-3v6" />
                        </svg>
                      }
                      title="No orders"
                      description={`No ${col.title.toLowerCase()} yet`}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
