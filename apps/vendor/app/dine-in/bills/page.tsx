"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { m, AnimatePresence } from "framer-motion";
import {
  PageHeader,
  ErrorBanner,
  Spinner,
  EmptyPanel,
  PrimaryButton,
} from "@/components/ui";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import {
  fetchVendorPendingBills,
  acknowledgeVendorBill,
  deliverVendorBill,
  type VendorPendingBillRow,
} from "@/lib/api";
import {
  billAction,
  billActionLabel,
  billBusyLabel,
  billMutationMessage,
  billQueueStatusMeta,
  type VendorBillAction,
} from "@/lib/dineInBills";
import { shortOrderId, relativeTime, formatINR } from "@/lib/format";

type BusyMap = Record<string, VendorBillAction>;

function BillStatusChip({ status }: { status: "PENDING" | "ACKNOWLEDGED" }) {
  const meta = billQueueStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export default function VendorBillsPage() {
  const [rows, setRows] = useState<VendorPendingBillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyMap, setBusyMap] = useState<BusyMap>({});

  // Locally confirmed mutations that the server has not yet committed into a
  // poll snapshot. A poll whose snapshot was taken before a mutation resolves
  // must not clobber the local patch, so the merge applies these until the
  // server snapshot agrees (status no longer PENDING for an acknowledge, or
  // the id disappears for a deliver).
  const busyRef = useRef<BusyMap>({});
  const deliveredRef = useRef<Set<string>>(new Set());
  const ackOverrideRef = useRef<Set<string>>(new Set());
  const restaurantGenerationRef = useRef(0);
  // Monotonic stamp per load attempt so an overlapping slow poll can never
  // clobber a newer queue snapshot with an older one (latest request wins).
  const loadVersionRef = useRef(0);

  const { activeRestaurantId } = useActiveRestaurant();

  useEffect(() => {
    const restaurantId = activeRestaurantId;
    if (!restaurantId) return;
    const generation = restaurantGenerationRef.current + 1;
    restaurantGenerationRef.current = generation;
    let stale = false;
    busyRef.current = {};
    setBusyMap({});
    deliveredRef.current = new Set();
    ackOverrideRef.current = new Set();
    loadVersionRef.current = 0;
    setRows([]);
    setFetchError("");
    setMutationError("");
    setLoading(true);

    async function load(rid: string) {
      const version = ++loadVersionRef.current;
      try {
        const data = await fetchVendorPendingBills(rid);
        if (stale || version !== loadVersionRef.current) return;
        // The queue order is server-authoritative (bill_requested_at ASC then
        // bill.id ASC). Preserve it exactly — never re-sort client-side.
        const removed = deliveredRef.current;
        const ackOverrides = ackOverrideRef.current;
        if (removed.size === 0 && ackOverrides.size === 0) {
          setRows(data);
        } else {
          const seen = new Set(data.map((r) => r.bill.id));
          for (const id of [...removed]) {
            if (!seen.has(id)) removed.delete(id);
          }
          for (const id of [...ackOverrides]) {
            const row = data.find((r) => r.bill.id === id);
            if (!row || row.bring_bill_request.status !== "PENDING") ackOverrides.delete(id);
          }
          setRows(
            data
              .filter((r) => !removed.has(r.bill.id))
              .map((r) =>
                ackOverrides.has(r.bill.id) && r.bring_bill_request.status === "PENDING"
                  ? {
                      ...r,
                      bring_bill_request: { ...r.bring_bill_request, status: "ACKNOWLEDGED" },
                    }
                  : r,
              ),
          );
        }
        setFetchError("");
      } catch (err) {
        if (stale || version !== loadVersionRef.current) return;
        setFetchError(err instanceof Error ? err.message : "Failed to load bill requests");
      } finally {
        if (!stale && version === loadVersionRef.current) setLoading(false);
      }
    }

    void load(restaurantId);
    const interval = setInterval(() => {
      void load(restaurantId);
    }, 15_000);
    return () => {
      stale = true;
      clearInterval(interval);
    };
  }, [activeRestaurantId]);

  function beginBusy(billId: string, action: VendorBillAction): boolean {
    if (busyRef.current[billId]) return false;
    busyRef.current = { ...busyRef.current, [billId]: action };
    setBusyMap(busyRef.current);
    return true;
  }

  function endBusy(billId: string) {
    const next = { ...busyRef.current };
    delete next[billId];
    busyRef.current = next;
    setBusyMap(next);
  }

  async function handleAcknowledge(row: VendorPendingBillRow) {
    if (!beginBusy(row.bill.id, "acknowledge")) return;
    const generation = restaurantGenerationRef.current;
    setMutationError("");
    try {
      await acknowledgeVendorBill(row.bill.id);
      if (restaurantGenerationRef.current !== generation) return;
      ackOverrideRef.current.add(row.bill.id);
      setRows((prev) =>
        prev.map((r) =>
          r.bill.id === row.bill.id
            ? {
                ...r,
                bring_bill_request: { ...r.bring_bill_request, status: "ACKNOWLEDGED" },
              }
            : r,
        ),
      );
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setMutationError(billMutationMessage(code, err instanceof Error ? err.message : undefined));
      if (code === "BILL_NOT_FOUND" || code === "INVALID_SERVICE_REQUEST_TRANSITION") {
        void loadForReconcile(restaurantGenerationRef.current);
      }
    } finally {
      if (restaurantGenerationRef.current === generation) endBusy(row.bill.id);
    }
  }

  async function handleDeliver(row: VendorPendingBillRow) {
    if (!beginBusy(row.bill.id, "deliver")) return;
    const generation = restaurantGenerationRef.current;
    setMutationError("");
    try {
      await deliverVendorBill(row.bill.id);
      if (restaurantGenerationRef.current !== generation) return;
      deliveredRef.current.add(row.bill.id);
      ackOverrideRef.current.delete(row.bill.id);
      setRows((prev) => prev.filter((r) => r.bill.id !== row.bill.id));
    } catch (err) {
      if (restaurantGenerationRef.current !== generation) return;
      const code = (err as Error & { code?: string }).code;
      setMutationError(billMutationMessage(code, err instanceof Error ? err.message : undefined));
      if (code === "BILL_NOT_FOUND" || code === "INVALID_SERVICE_REQUEST_TRANSITION") {
        void loadForReconcile(restaurantGenerationRef.current);
      }
    } finally {
      if (restaurantGenerationRef.current === generation) endBusy(row.bill.id);
    }
  }

  // Reconcile with the server after a mutation was rejected (stale 409 or a
  // vanished 404) so the queue never shows an invented state. Runs only for the
  // current restaurant generation.
  async function loadForReconcile(generation: number) {
    const restaurantId = activeRestaurantId;
    if (!restaurantId) return;
    // Supersede any in-flight poll whose snapshot predates this reconcile so a
    // late stale response cannot clobber the reconciled queue.
    const version = ++loadVersionRef.current;
    try {
      const data = await fetchVendorPendingBills(restaurantId);
      if (restaurantGenerationRef.current !== generation) return;
      if (version !== loadVersionRef.current) return;
      deliveredRef.current = new Set();
      ackOverrideRef.current = new Set();
      setRows(data);
      setMutationError("");
    } catch {
      // The poll cadence will keep retrying; no additional error copy is needed.
    }
  }

  if (!activeRestaurantId || (loading && rows.length === 0)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const pendingCount = rows.filter((r) => r.bring_bill_request.status === "PENDING").length;
  const acknowledgedCount = rows.filter((r) => r.bring_bill_request.status === "ACKNOWLEDGED")
    .length;
  const liveText = `${pendingCount} waiting, ${acknowledgedCount} being handled, ${rows.length} open bill requests`;
  const empty = rows.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bill Requests"
        subtitle={
          empty
            ? "No open bill requests"
            : `${pendingCount} waiting to be acknowledged, ${acknowledgedCount} being handled`
        }
        actions={
          <>
            <Link
              href="/dine-in"
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
            >
              Orders &amp; requests
            </Link>
            <Link
              href="/dine-in/tables"
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
            >
              Table board
            </Link>
          </>
        }
      />

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {liveText}
      </p>

      <ErrorBanner message={fetchError} />
      <ErrorBanner message={mutationError} />

      {empty ? (
        loading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <EmptyPanel
            title={fetchError !== "" ? "Couldn't load bill requests" : "No bill requests"}
            description={
              fetchError !== ""
                ? "The queue will keep retrying. Tables that ask for the bill should appear here."
                : "When a table asks for the bill it will appear here for you to acknowledge and deliver."
            }
          />
        )
      ) : (
        <ul role="list" aria-label="Bill request queue" className="space-y-3">
          <AnimatePresence mode="popLayout" initial={false}>
            {rows.map((row) => {
              const action = billAction(row.bring_bill_request.status);
              const busyKind = busyMap[row.bill.id];
              const busyThis = busyKind !== undefined;
              const busyLabel = busyKind !== undefined ? billBusyLabel(busyKind) : null;
              const actionLabel = busyLabel ?? billActionLabel(action);
              return (
                <m.li
                  key={row.bill.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.15 }}
                  aria-label={`Table ${row.table.label} bill request, ${billQueueStatusMeta(
                    row.bring_bill_request.status,
                  ).label.toLowerCase()}`}
                  className="flex flex-col rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold text-slate-900" title={row.table.label}>
                        {row.table.label}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        <span className="font-mono font-semibold text-slate-600">
                          #{shortOrderId(row.bill.id)}
                        </span>
                        <span className="mx-1.5" aria-hidden="true">
                          ·
                        </span>
                        <span>Requested {relativeTime(row.session.bill_requested_at)}</span>
                      </p>
                    </div>
                    <BillStatusChip status={row.bring_bill_request.status} />
                  </div>

                  <p className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2">
                    <span className="text-xs text-slate-400">Total</span>
                    <span className="text-base font-bold tabular-nums text-slate-900">
                      {formatINR(row.bill.total_amount)}
                    </span>
                  </p>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <PrimaryButton
                      onClick={() =>
                        action === "acknowledge"
                          ? void handleAcknowledge(row)
                          : void handleDeliver(row)
                      }
                      disabled={busyThis}
                      className="w-full sm:w-auto"
                    >
                      {actionLabel}
                    </PrimaryButton>
                    <Link
                      href={`/dine-in/bills/${row.bill.id}`}
                      className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      View bill
                    </Link>
                  </div>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
