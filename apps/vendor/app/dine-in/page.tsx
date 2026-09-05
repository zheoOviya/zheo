"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { m, AnimatePresence } from "framer-motion";
import { Badge, EmptyState } from "@snakzap/ui";
import {
  fetchDineInOrders,
  advanceDineInOrder,
  cancelDineInOrder,
  fetchDineInServiceRequests,
  acknowledgeDineInServiceRequest,
  completeDineInServiceRequest,
  type VendorDineInOrder,
  type VendorServiceRequest,
  type DineInOrderStatus,
  type ServiceRequestStatus,
} from "@/lib/api";
import {
  dineInStatusMeta,
  nextDineInTarget,
  dineInActionLabel,
  isDineInCancellable,
  dineInMutationMessage,
  DINE_IN_ACTIVE_STATUSES,
} from "@/lib/dineIn";
import {
  serviceRequestStatusMeta,
  serviceRequestTypeLabel,
  serviceRequestAction,
  serviceRequestActionLabel,
  serviceRequestBusyLabel,
  serviceRequestMutationMessage,
  isRenderableServiceRequest,
} from "@/lib/serviceRequests";
import type { ServiceRequestAction } from "@/lib/serviceRequests";
import { formatINR, formatTime, shortOrderId, relativeTime } from "@/lib/format";
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
type SrBusyMap = Record<string, ServiceRequestAction>;

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

function ServiceRequestStatusChip({ status }: { status: ServiceRequestStatus }) {
  const meta = serviceRequestStatusMeta(status);
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

  const [requests, setRequests] = useState<VendorServiceRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsFetchError, setRequestsFetchError] = useState("");
  const [requestMutationError, setRequestMutationError] = useState("");
  const [requestBusyMap, setRequestBusyMap] = useState<SrBusyMap>({});

  const busyRef = useRef<BusyMap>({});
  const requestBusyRef = useRef<SrBusyMap>({});
  // Locally confirmed mutations that the server has not yet committed into a
  // poll snapshot. A poll whose snapshot was taken before a mutation resolves
  // must not clobber the local patch, so merge applies these until the server
  // snapshot agrees (status no longer PENDING, or the id disappears).
  const srCompletedRef = useRef<Set<string>>(new Set());
  const srAckOverrideRef = useRef<Map<string, ServiceRequestStatus>>(new Map());
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
    requestBusyRef.current = {};
    setRequestBusyMap({});
    srCompletedRef.current = new Set();
    srAckOverrideRef.current = new Map();
    setRequests([]);
    setRequestsFetchError("");
    setRequestMutationError("");
    setRequestsLoading(true);

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

    async function loadRequests(rid: string) {
      try {
        const data = await fetchDineInServiceRequests(rid);
        if (stale) return;
        // Defensive render guard: never surface a BRING_BILL or terminal row
        // even if a server regression ever allowed one through.
        const rows = data.filter(isRenderableServiceRequest);
        const removed = srCompletedRef.current;
        const ackOverrides = srAckOverrideRef.current;
        if (removed.size === 0 && ackOverrides.size === 0) {
          setRequests(rows);
        } else {
          // A locally completed id stays suppressed until the server snapshot
          // stops containing it; a locally acknowledged id keeps ACKNOWLEDGED
          // until the server snapshot reflects it (status no longer PENDING or
          // the row is gone). This stops a poll taken before a mutation's
          // commit from resurrecting/regressing rows we already acted on.
          const seen = new Set(rows.map((r) => r.id));
          for (const id of [...removed]) {
            if (!seen.has(id)) removed.delete(id);
          }
          for (const id of [...ackOverrides.keys()]) {
            const row = rows.find((r) => r.id === id);
            if (!row || row.status !== "PENDING") ackOverrides.delete(id);
          }
          setRequests(
            rows
              .filter((r) => !removed.has(r.id))
              .map((r) =>
                ackOverrides.has(r.id) && r.status === "PENDING"
                  ? { ...r, status: "ACKNOWLEDGED" }
                  : r,
              ),
          );
        }
        setRequestsFetchError("");
      } catch (err) {
        if (stale) return;
        setRequestsFetchError(
          err instanceof Error ? err.message : "Failed to load service requests",
        );
      } finally {
        if (!stale) setRequestsLoading(false);
      }
    }

    void load(restaurantId);
    void loadRequests(restaurantId);
    const interval = setInterval(() => {
      void load(restaurantId);
      void loadRequests(restaurantId);
    }, 15_000);
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

  function beginRequestBusy(requestId: string, action: ServiceRequestAction): boolean {
    if (requestBusyRef.current[requestId]) return false;
    requestBusyRef.current = { ...requestBusyRef.current, [requestId]: action };
    setRequestBusyMap(requestBusyRef.current);
    return true;
  }

  function endRequestBusy(requestId: string) {
    const next = { ...requestBusyRef.current };
    delete next[requestId];
    requestBusyRef.current = next;
    setRequestBusyMap(next);
  }

  async function handleAcknowledge(request: VendorServiceRequest) {
    if (!beginRequestBusy(request.id, "acknowledge")) return;
    const generation = restaurantGenerationRef.current;
    setRequestMutationError("");
    try {
      const result = await acknowledgeDineInServiceRequest(request.id);
      if (restaurantGenerationRef.current !== generation) return;
      const nextStatus = result.request.status;
      srAckOverrideRef.current.set(request.id, nextStatus);
      setRequests((prev) =>
        prev.map((r) => (r.id === request.id ? { ...r, status: nextStatus } : r)),
      );
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setRequestMutationError(
        serviceRequestMutationMessage(code, err instanceof Error ? err.message : undefined),
      );
    } finally {
      if (restaurantGenerationRef.current === generation) endRequestBusy(request.id);
    }
  }

  async function handleComplete(request: VendorServiceRequest) {
    if (!beginRequestBusy(request.id, "complete")) return;
    const generation = restaurantGenerationRef.current;
    setRequestMutationError("");
    try {
      await completeDineInServiceRequest(request.id);
      if (restaurantGenerationRef.current !== generation) return;
      srCompletedRef.current.add(request.id);
      srAckOverrideRef.current.delete(request.id);
      setRequests((prev) => prev.filter((r) => r.id !== request.id));
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setRequestMutationError(
        serviceRequestMutationMessage(code, err instanceof Error ? err.message : undefined),
      );
    } finally {
      if (restaurantGenerationRef.current === generation) endRequestBusy(request.id);
    }
  }

  if (!activeRestaurantId || (loading && orders.length === 0)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const renderableRequests = requests.filter(isRenderableServiceRequest);
  const pendingRequestCount = renderableRequests.filter((r) => r.status === "PENDING").length;
  const acknowledgedRequestCount = renderableRequests.filter(
    (r) => r.status === "ACKNOWLEDGED",
  ).length;
  const requestLiveText = `${pendingRequestCount} waiting, ${acknowledgedRequestCount} in progress, ${renderableRequests.length} open service requests`;
  const requestsEmpty = renderableRequests.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dine-In Orders"
        subtitle={`${orders.length} active dine-in order${orders.length === 1 ? "" : "s"}`}
        actions={
          <Link
            href="/dine-in/tables"
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
          >
            Table board
          </Link>
        }
      />

      <ErrorBanner message={fetchError} />
      <ErrorBanner message={mutationError} />

      <section
        aria-labelledby="service-requests-heading"
        className="rounded-xl border border-slate-200 bg-white shadow-sm"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 id="service-requests-heading" className="text-sm font-bold text-slate-700">
              Service Requests
            </h2>
            <p className="text-xs text-slate-400">
              {pendingRequestCount > 0
                ? `${pendingRequestCount} waiting to be acknowledged`
                : acknowledgedRequestCount > 0
                  ? `${acknowledgedRequestCount} being handled`
                  : "No open requests"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pendingRequestCount > 0 && (
              <Badge variant="amber" size="sm">
                Waiting {pendingRequestCount}
              </Badge>
            )}
            {acknowledgedRequestCount > 0 && (
              <Badge variant="default" size="sm">
                In progress {acknowledgedRequestCount}
              </Badge>
            )}
          </div>
        </header>

        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {requestLiveText}
        </p>

        <div className="space-y-3 p-3">
          <ErrorBanner message={requestsFetchError} />
          <ErrorBanner message={requestMutationError} />

          {requestsEmpty ? (
            requestsLoading ? (
              <div className="flex h-28 items-center justify-center">
                <Spinner className="h-6 w-6" />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center">
                <p className="text-sm font-semibold text-slate-600">
                  {requestsFetchError ? "Couldn't load service requests" : "No service requests"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {requestsFetchError
                    ? "The board will keep retrying. Pull from the floor should appear here."
                    : "New requests from tables will appear here."}
                </p>
              </div>
            )
          ) : (
            <ul role="list" aria-label="Service request queue" className="space-y-3">
              <AnimatePresence mode="popLayout" initial={false}>
                {renderableRequests.map((request) => {
                  const busyKind = requestBusyMap[request.id];
                  const busyThis = busyKind !== undefined;
                  const action = serviceRequestAction(request.status);
                  const actionLabel =
                    busyKind !== undefined
                      ? serviceRequestBusyLabel(busyKind)
                      : serviceRequestActionLabel(action);

                  return (
                    <m.li
                      key={`${request.id}:${request.status}`}
                      layout
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      transition={{ duration: 0.15 }}
                      aria-label={`Table ${request.table.label} ${serviceRequestTypeLabel(request.request_type).toLowerCase()} request, ${serviceRequestStatusMeta(request.status).label.toLowerCase()}`}
                      className="flex flex-col rounded-xl border border-slate-200 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p
                            className="truncate text-base font-bold text-slate-900"
                            title={request.table.label}
                          >
                            {request.table.label}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            <span className="font-semibold text-slate-600">
                              {serviceRequestTypeLabel(request.request_type)}
                            </span>
                            <span className="mx-1.5" aria-hidden="true">
                              ·
                            </span>
                            {relativeTime(request.created_at)}
                          </p>
                        </div>
                        <ServiceRequestStatusChip status={request.status} />
                      </div>

                      {request.note && (
                        <p className="mt-2 break-words rounded-md bg-slate-50 px-2.5 py-1.5 text-sm text-slate-600 ring-1 ring-inset ring-slate-100">
                          “{request.note}”
                        </p>
                      )}

                      {action && (
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          <PrimaryButton
                            onClick={() =>
                              action === "acknowledge"
                                ? void handleAcknowledge(request)
                                : void handleComplete(request)
                            }
                            disabled={busyThis}
                            className="w-full"
                          >
                            {actionLabel}
                          </PrimaryButton>
                        </div>
                      )}
                    </m.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </section>

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
