"use client";

import { useEffect, useRef, useState } from "react";
import { m, AnimatePresence } from "framer-motion";
import { Badge, EmptyState } from "@snakzap/ui";
import {
  fetchDineInOrders,
  advanceDineInOrder,
  cancelDineInOrder,
  type VendorDineInOrder,
  type DineInOrderStatus,
} from "@/lib/api";
import {
  dineInStatusMeta,
  nextDineInTarget,
  dineInActionLabel,
  isDineInCancellable,
  dineInMutationMessage,
  DINE_IN_ACTIVE_STATUSES,
} from "@/lib/dineIn";
import { formatINR, formatTime, shortOrderId } from "@/lib/format";
import {
  PageHeader,
  ErrorBanner,
  Spinner,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";

type BusyKind = "advance" | "cancel";
type BusyMap = Record<string, BusyKind>;

function StatusChip({ status }: { status: DineInOrderStatus }) {
  const meta = dineInStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export default function DineInPage() {
  const [orders, setOrders] = useState<VendorDineInOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyMap, setBusyMap] = useState<BusyMap>({});
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const busyRef = useRef<BusyMap>({});
  const restaurantGenerationRef = useRef(0);

  const { activeRestaurantId } = useActiveRestaurant();

  useEffect(() => {
    const restaurantId = activeRestaurantId;
    if (!restaurantId) return;
    const generation = restaurantGenerationRef.current + 1;
    restaurantGenerationRef.current = generation;
    let stale = false;
    busyRef.current = {};
    setBusyMap({});
    setConfirmCancelId(null);
    setOrders([]);
    setFetchError("");
    setMutationError("");
    setLoading(true);

    async function load(rid: string) {
      try {
        const data = await fetchDineInOrders(rid);
        if (stale) return;
        setOrders(data);
        setFetchError("");
      } catch (err) {
        if (stale) return;
        setFetchError(err instanceof Error ? err.message : "Failed to load dine-in orders");
      } finally {
        if (!stale) setLoading(false);
      }
    }

    void load(restaurantId);
    const interval = setInterval(() => void load(restaurantId), 15_000);
    return () => {
      stale = true;
      clearInterval(interval);
    };
  }, [activeRestaurantId]);

  function beginBusy(orderId: string, kind: BusyKind): boolean {
    if (busyRef.current[orderId]) return false;
    busyRef.current = { ...busyRef.current, [orderId]: kind };
    setBusyMap(busyRef.current);
    return true;
  }

  function endBusy(orderId: string) {
    const next = { ...busyRef.current };
    delete next[orderId];
    busyRef.current = next;
    setBusyMap(next);
  }

  async function handleAdvance(order: VendorDineInOrder) {
    const target = nextDineInTarget(order.status);
    if (!target || !beginBusy(order.id, "advance")) return;
    const generation = restaurantGenerationRef.current;
    setMutationError("");
    setConfirmCancelId((current) => (current === order.id ? null : current));
    try {
      const result = await advanceDineInOrder(order.id, target);
      if (restaurantGenerationRef.current !== generation) return;
      const next = result.order.status;
      if (next === "SERVED") {
        setOrders((prev) => prev.filter((o) => o.id !== order.id));
      } else {
        setOrders((prev) =>
          prev.map((o) => (o.id === order.id ? { ...o, status: next } : o)),
        );
      }
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setMutationError(dineInMutationMessage(code, err instanceof Error ? err.message : undefined));
    } finally {
      if (restaurantGenerationRef.current === generation) endBusy(order.id);
    }
  }

  async function handleCancel(order: VendorDineInOrder) {
    if (!beginBusy(order.id, "cancel")) return;
    const generation = restaurantGenerationRef.current;
    setMutationError("");
    try {
      await cancelDineInOrder(order.id);
      if (restaurantGenerationRef.current !== generation) return;
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setConfirmCancelId(null);
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setMutationError(dineInMutationMessage(code, err instanceof Error ? err.message : undefined));
      setConfirmCancelId(null);
    } finally {
      if (restaurantGenerationRef.current === generation) endBusy(order.id);
    }
  }

  if (!activeRestaurantId || (loading && orders.length === 0)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dine-In Orders"
        subtitle={`${orders.length} active dine-in order${orders.length === 1 ? "" : "s"}`}
      />

      <ErrorBanner message={fetchError} />
      <ErrorBanner message={mutationError} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {DINE_IN_ACTIVE_STATUSES.map((status) => {
          const meta = dineInStatusMeta(status);
          const laneOrders = orders.filter((o) => o.status === status);

          return (
            <section
              key={status}
              aria-label={`${meta.label} orders`}
              className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-bold text-slate-700">{meta.label}</h2>
                <Badge variant="default" size="sm">
                  {laneOrders.length}
                </Badge>
              </header>

              <div className="min-h-0 flex-1 space-y-3 p-3">
                {laneOrders.length === 0 ? (
                  <EmptyState
                    icon={
                      <svg
                        className="h-8 w-8"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1}
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h12v12H6z" />
                      </svg>
                    }
                    title="No orders"
                    description={`No ${meta.label.toLowerCase()} orders right now`}
                  />
                ) : (
                  <ul role="list" className="space-y-3">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {laneOrders.map((order) => {
                        const busyKind = busyMap[order.id];
                        const busyThis = busyKind !== undefined;
                        const advancing = busyKind === "advance";
                        const cancelling = busyKind === "cancel";
                        const advanceLabel = dineInActionLabel(order.status);
                        const cancellable = isDineInCancellable(order.status);
                        const confirmingCancel = confirmCancelId === order.id;

                        return (
                          <m.li
                            key={order.id}
                            layout
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.15 }}
                            aria-label={`Table ${order.table.label} order #${shortOrderId(order.id)}, ${meta.label.toLowerCase()}`}
                            className="flex flex-col rounded-xl border border-slate-200 p-3"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p
                                  className="truncate text-lg font-bold text-slate-900"
                                  title={order.table.label}
                                >
                                  {order.table.label}
                                </p>
                                <p className="mt-0.5 font-mono text-xs text-slate-500">
                                  #{shortOrderId(order.id)} · {formatTime(order.created_at)}
                                </p>
                              </div>
                              <StatusChip status={order.status} />
                            </div>

                            <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2">
                              {order.items.map((item) => (
                                <li
                                  key={item.menu_item_id}
                                  className="flex items-start justify-between gap-3 text-sm"
                                >
                                  <span className="break-words text-slate-700">{item.name}</span>
                                  <span className="shrink-0 font-mono text-slate-500">
                                    x{item.quantity}
                                  </span>
                                </li>
                              ))}
                            </ul>

                            <p className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2">
                              <span className="text-xs text-slate-400">Total</span>
                              <span className="text-base font-bold tabular-nums text-slate-900">
                                {formatINR(order.total_amount)}
                              </span>
                            </p>

                            <div className="mt-3 space-y-2">
                              {advanceLabel && (
                                <PrimaryButton
                                  onClick={() => void handleAdvance(order)}
                                  disabled={busyThis}
                                  className="w-full"
                                >
                                  {advancing ? "Updating..." : advanceLabel}
                                </PrimaryButton>
                              )}

                              {cancellable && !confirmingCancel && (
                                <SecondaryButton
                                  onClick={() => setConfirmCancelId(order.id)}
                                  disabled={busyThis}
                                  className="w-full border-red-200 text-red-600 hover:bg-red-50"
                                >
                                  Cancel Order
                                </SecondaryButton>
                              )}

                              {cancellable && confirmingCancel && (
                                <div className="space-y-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleCancel(order)}
                                    disabled={busyThis}
                                    className="min-h-[40px] w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {cancelling ? "Cancelling..." : "Confirm cancel?"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmCancelId(null)}
                                    disabled={busyThis}
                                    className="w-full py-1 text-sm text-slate-400 hover:text-slate-600 disabled:opacity-50"
                                  >
                                    Keep order
                                  </button>
                                </div>
                              )}
                            </div>
                          </m.li>
                        );
                      })}
                    </AnimatePresence>
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
