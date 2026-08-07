"use client";

import { useEffect, useState, useCallback } from "react";
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

const UI_STATUS: Record<string, { label: string; color: string }> = {
  CONFIRMED: { label: "New", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  PREPARING: { label: "Preparing", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  ALMOST_READY: { label: "Almost Ready", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  READY_FOR_PICKUP: { label: "Ready", color: "bg-green-500/20 text-green-400 border-green-500/30" },
};

export default function VendorDashboard() {
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [error, setError] = useState("");
  const [otpInput, setOtpInput] = useState<Record<string, string>>({});
  const [qrInput, setQrInput] = useState<Record<string, string>>({});
  const { updates, connected } = useOrdersWebSocket(RESTAURANT_ID);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/vendor/orders?restaurant_id=${RESTAURANT_ID}`,
      );
      const body = await res.json();
      if (body.success) setOrders(body.data);
    } catch (err) {
      setError("Failed to load orders");
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 10000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  // Apply live WebSocket updates to order statuses
  useEffect(() => {
    if (updates.length === 0) return;
    const latest = updates[0];
    if (!latest) return;
    setOrders((prev) =>
      prev.map((o) =>
        o.id === latest.data.order_id
          ? { ...o, status: latest.data.sql_status }
          : o,
      ),
    );
  }, [updates]);

  async function advanceOrder(orderId: string) {
    try {
      const res = await fetch(
        `/api/vendor/orders/${orderId}/status`,
        { method: "PUT" },
      );
      const body = await res.json();
      if (body.success) {
        setOrders((prev) =>
          prev.map((o) =>
            o.id === orderId ? { ...o, status: body.data.status } : o,
          ),
        );
      }
    } catch {
      // ignore
    }
  }

  async function confirmPickup(orderId: string) {
    const otp = otpInput[orderId];
    const qr = qrInput[orderId];
    if (!otp && !qr) return;

    try {
      const res = await fetch(
        `/api/v1/orders/${orderId}/confirm-pickup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            otp ? { pickup_otp: otp } : { qr_token: qr },
          ),
        },
      );
      const body = await res.json();
      if (body.success) {
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
      }
    } catch {
      // ignore
    }
  }

  const pending = orders.filter((o) => o.status !== "READY_FOR_PICKUP");
  const ready = orders.filter((o) => o.status === "READY_FOR_PICKUP");

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-400">Kitchen Display</h1>
          <p className="mt-1 text-sm text-primary-600/50">
            {orders.length} active orders
            <span className={`ml-2 inline-block h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          </p>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="space-y-6">
        {/* Pending orders */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-primary-300">
            Pending ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map((order) => {
              const statusInfo = UI_STATUS[order.status] ?? {
                label: order.status,
                color: "bg-gray-500/20 text-gray-400",
              };
              return (
                <div
                  key={order.id}
                  className="rounded-2xl bg-primary-900/30 border border-primary-500/10 p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium border ${statusInfo.color}`}>
                          {statusInfo.label}
                        </span>
                        {order.checked_in && (
                          <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                            Here
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-neutral-300">
                        {order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
                      </p>
                      <p className="mt-1 text-xs text-primary-600/50">
                        {formatINR(order.total_amount)} &middot; {new Date(order.created_at).toLocaleTimeString()}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => advanceOrder(order.id)}
                      className="ml-3 rounded-full bg-primary-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover active:scale-95 transition-transform"
                    >
                      {order.status === "CONFIRMED"
                        ? "Start"
                        : order.status === "PREPARING"
                          ? "Almost Ready"
                          : "Mark Ready"}
                    </button>
                  </div>
                </div>
              );
            })}
            {pending.length === 0 && (
              <p className="py-8 text-center text-sm text-primary-600/30">
                No pending orders
              </p>
            )}
          </div>
        </section>

        {/* Ready for pickup */}
        {ready.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-green-400">
              Ready for Pickup ({ready.length})
            </h2>
            <div className="space-y-3">
              {ready.map((order) => (
                <div
                  key={order.id}
                  className="rounded-2xl bg-green-500/5 border border-green-500/20 p-4"
                >
                  <p className="text-sm font-medium text-neutral-200">
                    {order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1">
                      {order.pickup_otp && (
                        <p className="mb-1.5 text-xs text-neutral-400">
                          Pickup code:{" "}
                          <span className="font-mono text-base font-bold tracking-widest text-green-400">
                            {order.pickup_otp}
                          </span>
                        </p>
                      )}
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        placeholder="Enter code"
                        value={otpInput[order.id] ?? ""}
                        onChange={(e) =>
                          setOtpInput((p) => ({
                            ...p,
                            [order.id]: e.target.value.replace(/\D/g, "").slice(0, 4),
                          }))
                        }
                        className="w-full rounded-xl border border-primary-500/20 bg-primary-900/50 px-3 py-2 text-sm text-neutral-200 placeholder-primary-600/30 outline-none focus:border-primary-500"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => confirmPickup(order.id)}
                      disabled={
                        (otpInput[order.id] ?? "").length !== 4 &&
                        !qrInput[order.id]
                      }
                      className="rounded-full bg-green-600 px-4 py-2 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-30"
                    >
                      Handed Over
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
