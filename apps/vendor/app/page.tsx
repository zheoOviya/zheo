"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { m, AnimatePresence } from "framer-motion";
import { Badge, CountdownTimer, EmptyState } from "@snakzap/ui";
import { useOrdersWebSocket } from "@/hooks/useOrdersWebSocket";

interface OrderItem {
  name: string;
  quantity: number;
}

interface DashboardOrder {
  id: string;
  status: string;
  total_amount: number;
  items: OrderItem[];
  pickup_otp: string | null;
  qr_token: string | null;
  checked_in: boolean;
  created_at: string;
}

const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";

function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

interface ColumnConfig {
  status: string;
  title: string;
  prepSeconds: number;
}

const COLUMNS: ColumnConfig[] = [
  { status: "CONFIRMED", title: "New Orders", prepSeconds: 600 },
  { status: "PREPARING", title: "Preparing", prepSeconds: 480 },
  { status: "ALMOST_READY", title: "Almost Ready", prepSeconds: 120 },
  { status: "READY_FOR_PICKUP", title: "Ready for Pickup", prepSeconds: 300 },
];

function timeElapsed(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
}

function urgencyClass(elapsed: number, max: number): string {
  const pct = max > 0 ? elapsed / max : 0;
  if (pct < 0.3) return "border-l-urgency-green";
  if (pct < 0.7) return "border-l-urgency-amber";
  return "border-l-urgency-red";
}

function urgencyBgClass(elapsed: number, max: number): string {
  const pct = max > 0 ? elapsed / max : 0;
  if (pct < 0.3) return "bg-urgency-green/5 dark:bg-urgency-green/10";
  if (pct < 0.7) return "bg-urgency-amber/5 dark:bg-urgency-amber/10";
  return "bg-urgency-red/5 dark:bg-urgency-red/10";
}

function urgencyLabel(elapsed: number, max: number): string {
  const pct = max > 0 ? elapsed / max : 0;
  if (pct < 0.3) return "On time";
  if (pct < 0.7) return "Running late";
  return "Urgent";
}

const STATUS_ADVANCE: Record<string, string> = {
  CONFIRMED: "PREPARING",
  PREPARING: "ALMOST_READY",
  ALMOST_READY: "READY_FOR_PICKUP",
};

const STATUS_BUTTON: Record<string, string> = {
  CONFIRMED: "Start",
  PREPARING: "Almost Ready",
  ALMOST_READY: "Mark Ready",
};

export default function VendorDashboard() {
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [error, setError] = useState("");
  const [otpInput, setOtpInput] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const { updates, connected } = useOrdersWebSocket(RESTAURANT_ID);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(`/api/vendor/orders?restaurant_id=${RESTAURANT_ID}`);
      const body = await res.json();
      if (body.success) setOrders(body.data);
    } catch {
      setError("Failed to load orders");
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    timerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(interval);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchOrders]);

  useEffect(() => {
    if (updates.length === 0) return;
    const latest = updates[0];
    if (!latest) return;
    setOrders((prev) =>
      prev.map((o) =>
        o.id === latest.data.order_id ? { ...o, status: latest.data.sql_status } : o,
      ),
    );
  }, [updates]);

  async function advanceOrder(orderId: string) {
    try {
      const res = await fetch(`/api/vendor/orders/${orderId}/status`, { method: "PUT" });
      const body = await res.json();
      if (body.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: body.data.status } : o)),
        );
      }
    } catch {
      // ignore
    }
  }

  async function confirmPickup(orderId: string) {
    const otp = otpInput[orderId];
    if (!otp) return;

    try {
      const res = await fetch(`/api/v1/orders/${orderId}/confirm-pickup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickup_otp: otp }),
      });
      const body = await res.json();
      if (body.success) {
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
      }
    } catch {
      // ignore
    }
  }

  const activeOrders = orders.filter((o) => o.status !== "READY_FOR_PICKUP");
  const readyOrders = orders.filter((o) => o.status === "READY_FOR_PICKUP");

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-200">
      <header className="flex items-center justify-between shrink-0 border-b border-primary-500/10 px-5 py-3">
        <div>
          <h1 className="text-xl font-bold text-primary-400">Kitchen Display</h1>
          <p className="text-xs text-neutral-500" aria-live="polite">
            {orders.length} orders
            <span className={`ml-2 inline-block h-2 w-2 rounded-full ${connected ? "bg-urgency-green" : "bg-urgency-red"}`} aria-hidden="true" />
            <span className="ml-1">{connected ? "Connected" : "Offline"}</span>
          </p>
        </div>
        <span className="font-mono text-sm text-neutral-400 tabular-nums">
          {new Date(now).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </header>

      {error && (
        <p className="m-4 rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="grid h-full grid-cols-2 gap-3 p-4 md:grid-cols-3 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const colOrders = col.status === "READY_FOR_PICKUP"
              ? readyOrders
              : activeOrders.filter((o) => o.status === col.status);

            return (
              <div key={col.status} className="flex min-h-0 min-w-0 flex-col rounded-xl bg-neutral-900/50 border border-neutral-800/50">
                <div className="flex items-center justify-between p-3 border-b border-neutral-800/50">
                  <h2 className="text-sm font-bold text-neutral-300">{col.title}</h2>
                  <Badge variant="default" size="sm">{colOrders.length}</Badge>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2" role="list">
                  <AnimatePresence mode="popLayout">
                    {colOrders.map((order) => {
                      const elapsed = timeElapsed(order.created_at);
                      const borderColor = urgencyClass(elapsed, col.prepSeconds);
                      const bgTint = urgencyBgClass(elapsed, col.prepSeconds);
                      const urgency = urgencyLabel(elapsed, col.prepSeconds);
                      const canAdvance = col.status in STATUS_ADVANCE;

                      return (
                        <m.div
                          key={order.id}
                          layout
                          role="listitem"
                          aria-label={`Order #${order.id.slice(-4).toUpperCase()}, ${col.title.toLowerCase()}, ${urgency}`}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{ duration: 0.2 }}
                          className={[
                            "rounded-xl border-l-4 p-4",
                            bgTint,
                            borderColor,
                            "border border-neutral-800/50",
                            "flex flex-col justify-between",
                          ].join(" ")}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <p className="text-lg font-mono font-bold text-white">
                                #{order.id.slice(-4).toUpperCase()}
                              </p>
                              {order.checked_in && (
                                <Badge variant="green" size="sm" pulse className="mt-1">
                                  Here
                                </Badge>
                              )}
                              <span className="mt-1 block text-2xs text-neutral-500">
                                {urgency}
                              </span>
                            </div>
                            <CountdownTimer targetSeconds={col.prepSeconds} />
                          </div>

                          <ul className="flex-1 space-y-1 pt-3">
                            {order.items.map((item) => (
                              <li key={item.name} className="flex justify-between text-sm">
                                <span className="text-neutral-300">{item.name}</span>
                                <span className="font-mono text-neutral-500">x{item.quantity}</span>
                              </li>
                            ))}
                          </ul>

                          <p className="text-2xs text-neutral-600 mt-3">
                            {formatINR(order.total_amount)} &middot; {new Date(order.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </p>

                          {canAdvance ? (
                            <button
                              type="button"
                              onClick={() => advanceOrder(order.id)}
                              aria-label={`Advance order #${order.id.slice(-4).toUpperCase()} from ${col.title} to ${STATUS_BUTTON[col.status]}`}
                              className="min-h-[44px] w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] hover:bg-primary-hover hover:-translate-y-px"
                            >
                              {STATUS_BUTTON[col.status]} &rarr;
                            </button>
                          ) : (
                            <div className="space-y-2">
                              {order.pickup_otp && (
                                <p className="text-xs text-neutral-400">
                                  Code:{" "}
                                  <span className="font-mono text-lg font-bold tracking-widest text-primary-400">
                                    {order.pickup_otp}
                                  </span>
                                </p>
                              )}
                              <label htmlFor={`otp-${order.id}`} className="sr-only">
                                Pickup OTP for order #{order.id.slice(-4).toUpperCase()}
                              </label>
                              <input
                                id={`otp-${order.id}`}
                                type="text"
                                inputMode="numeric"
                                maxLength={4}
                                placeholder="Enter OTP"
                                value={otpInput[order.id] ?? ""}
                                onChange={(e) =>
                                  setOtpInput((p) => ({
                                    ...p,
                                    [order.id]: e.target.value.replace(/\D/g, "").slice(0, 4),
                                  }))
                                }
                                className="min-h-[44px] w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-primary"
                              />
                              <button
                                type="button"
                                onClick={() => confirmPickup(order.id)}
                                disabled={(otpInput[order.id] ?? "").length !== 4}
                                aria-label={`Hand over order #${order.id.slice(-4).toUpperCase()}`}
                                className="min-h-[44px] w-full rounded-lg bg-urgency-green px-4 py-2.5 text-sm font-bold text-white transition-all duration-150 active:scale-[0.97] hover:brightness-110 disabled:opacity-30"
                              >
                                Hand Over
                              </button>
                            </div>
                          )}
                        </m.div>
                      );
                    })}
                  </AnimatePresence>

                  {colOrders.length === 0 && (
                    <EmptyState
                      icon={
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-3-3v6" />
                        </svg>
                      }
                      title="No orders"
                      description={`No ${col.title.toLowerCase()} orders yet`}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
