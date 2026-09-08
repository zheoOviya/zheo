"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  fetchAdminDineInSessionDetail,
  type AdminDineInLiveSessionStatus,
  type AdminDineInBillStatus,
  type AdminDineInSessionDetail,
} from "../../../../../lib/api";

const SESSION_STATUS_LABELS: Record<AdminDineInLiveSessionStatus, string> = {
  OPEN: "Open",
  ACTIVE: "Active",
  BILL_REQUESTED: "Bill requested",
  PAYMENT_PENDING: "Payment pending",
};

const SESSION_STATUS_COLORS: Record<AdminDineInLiveSessionStatus, string> = {
  OPEN: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  ACTIVE: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  BILL_REQUESTED: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  PAYMENT_PENDING: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
};

const BILL_STATUS_LABELS: Record<AdminDineInBillStatus, string> = {
  NONE: "None",
  REQUESTED: "Requested",
  ACKNOWLEDGED: "Acknowledged",
  DELIVERED: "Delivered",
};

const BILL_STATUS_COLORS: Record<AdminDineInBillStatus, string> = {
  NONE: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  REQUESTED: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ACKNOWLEDGED: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  DELIVERED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  PLACED: "Placed",
  PREPARING: "Preparing",
  READY_TO_SERVE: "Ready to serve",
  SERVED: "Served",
  CANCELLED: "Cancelled",
};

const SR_TYPE_LABELS: Record<string, string> = {
  WATER: "Water",
  EXTRA_PLATE: "Extra plate",
  CUTLERY: "Cutlery",
  TISSUE: "Tissue",
  CLEAN_TABLE: "Clean table",
  CALL_STAFF: "Call staff",
  BRING_BILL: "Bring bill",
  OTHER: "Other",
};

const SR_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  ACKNOWLEDGED: "Acknowledged",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleString();
const fmtMoney = (n: number) =>
  `Rs.${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
      <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">{title}</p>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-4 text-center text-sm text-neutral-400">{text}</p>;
}

export default function DineInSessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params?.sessionId ?? "";
  const [data, setData] = useState<AdminDineInSessionDetail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!sessionId) return;
    setError("");
    fetchAdminDineInSessionDetail(sessionId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load session"));
  }, [sessionId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const notFound = error && /not found/i.test(error);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/dine-in" className="text-sm text-primary-500 hover:underline">
            ← Back to Dine-In Oversight
          </Link>
          <h2 className="mt-1 text-xl font-bold text-neutral-900 dark:text-neutral-100">
            Session detail
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Refreshes automatically every 60s.</p>
        </div>
        {data && (
          <button
            onClick={load}
            className="rounded-lg bg-primary-500 hover:bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors"
          >
            Refresh
          </button>
        )}
      </div>

      {notFound ? (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-10 text-center">
          <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-200">Session not found</p>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            This session is closed or no longer available for live oversight.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {!data && !error && (
            <div className="space-y-4">
              <div className="h-24 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
            </div>
          )}

          {data && (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
                  <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">Context</p>
                  <dl className="space-y-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Restaurant</dt>
                      <dd className="font-medium text-neutral-800 dark:text-neutral-200">{data.restaurant.restaurant_name}</dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Table</dt>
                      <dd className="font-mono text-neutral-800 dark:text-neutral-200">
                        {data.table.table_label}
                        {data.table.seat_count != null && (
                          <span className="ml-2 text-xs font-normal text-neutral-400">({data.table.seat_count} seats)</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Zone</dt>
                      <dd className="text-neutral-800 dark:text-neutral-200">{data.zone?.zone_name ?? "—"}</dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Session status</dt>
                      <dd>
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${SESSION_STATUS_COLORS[data.session.status]}`}>
                          {SESSION_STATUS_LABELS[data.session.status]}
                        </span>
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Opened</dt>
                      <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.session.opened_at)}</dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Last updated</dt>
                      <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.session.updated_at)}</dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
                  <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">Bill</p>
                  <div className="space-y-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-neutral-500 dark:text-neutral-400">Bill status</dt>
                      <dd>
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${BILL_STATUS_COLORS[data.bill.status]}`}>
                          {BILL_STATUS_LABELS[data.bill.status]}
                        </span>
                      </dd>
                    </div>
                    {data.session.bill_requested_at && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-neutral-500 dark:text-neutral-400">Bill requested at</dt>
                        <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.session.bill_requested_at)}</dd>
                      </div>
                    )}
                    {data.bill.requested_at && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-neutral-500 dark:text-neutral-400">Request received</dt>
                        <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.bill.requested_at)}</dd>
                      </div>
                    )}
                    {data.bill.acknowledged_at && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-neutral-500 dark:text-neutral-400">Acknowledged at</dt>
                        <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.bill.acknowledged_at)}</dd>
                      </div>
                    )}
                    {data.bill.delivered_at && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-neutral-500 dark:text-neutral-400">Delivered at</dt>
                        <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.bill.delivered_at)}</dd>
                      </div>
                    )}
                    {data.session.payment_pending_at && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-neutral-500 dark:text-neutral-400">Payment pending since</dt>
                        <dd className="text-neutral-700 dark:text-neutral-300">{fmtTime(data.session.payment_pending_at)}</dd>
                      </div>
                    )}
                    {data.bill.totals && (
                      <div className="rounded-lg bg-neutral-50 dark:bg-neutral-950 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Frozen bill totals</p>
                        <dl className="space-y-1 text-xs text-neutral-700 dark:text-neutral-300">
                          <div className="flex justify-between"><dt>Food subtotal</dt><dd className="font-mono tabular-nums">{fmtMoney(data.bill.totals.food_subtotal)}</dd></div>
                          <div className="flex justify-between"><dt>Packaging fee</dt><dd className="font-mono tabular-nums">{fmtMoney(data.bill.totals.packaging_fee)}</dd></div>
                          <div className="flex justify-between"><dt>GST on food</dt><dd className="font-mono tabular-nums">{fmtMoney(data.bill.totals.gst_food)}</dd></div>
                          <div className="flex justify-between"><dt>GST on packaging</dt><dd className="font-mono tabular-nums">{fmtMoney(data.bill.totals.gst_packaging)}</dd></div>
                          <div className="flex justify-between border-t border-neutral-200 dark:border-neutral-800 pt-1"><dt className="font-semibold">Total</dt><dd className="font-mono font-semibold tabular-nums">{fmtMoney(data.bill.totals.total_amount)}</dd></div>
                        </dl>
                        <p className="mt-2 text-xs text-neutral-400">Frozen {fmtTime(data.bill.totals.frozen_at)}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <Section title="Orders">
                {data.orders.length === 0 ? (
                  <EmptyState text="No orders yet." />
                ) : (
                  <div className="space-y-4">
                    {data.orders.map((order) => (
                      <div key={order.id} className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-xs">
                          <span className="font-mono text-neutral-500">{order.id.slice(0, 12)}...</span>
                          <span className="flex items-center gap-2">
                            <span className={`inline-block rounded-full px-2 py-0.5 font-semibold ${order.status === "CANCELLED" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"}`}>
                              {ORDER_STATUS_LABELS[order.status] ?? order.status}
                            </span>
                            <span className="text-neutral-500">{fmtTime(order.created_at)}</span>
                            <span className="font-mono font-semibold tabular-nums text-neutral-700 dark:text-neutral-300">{fmtMoney(order.total_amount)}</span>
                          </span>
                        </div>
                        <table className="w-full text-left text-xs">
                          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                            {order.items.map((item, idx) => (
                              <tr key={`${order.id}-${item.name}-${idx}`}>
                                <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{item.name}</td>
                                <td className="px-3 py-2 text-neutral-500">× {item.quantity}</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-700 dark:text-neutral-300">{fmtMoney(item.item_subtotal)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Service requests">
                {data.service_requests.length === 0 ? (
                  <EmptyState text="No service requests." />
                ) : (
                  <div className="space-y-2">
                    {data.service_requests.map((req) => (
                      <div key={req.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-neutral-800 dark:text-neutral-200">
                            {SR_TYPE_LABELS[req.request_type] ?? req.request_type}
                          </span>
                          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                            req.status === "CANCELLED"
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              : req.status === "COMPLETED"
                                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                          }`}>
                            {SR_STATUS_LABELS[req.status] ?? req.status}
                          </span>
                          {req.note && <span className="text-xs text-neutral-500 italic">"{req.note}"</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                          <span>Requested {fmtTime(req.created_at)}</span>
                          {req.acknowledged_at && <span>Acknowledged {fmtTime(req.acknowledged_at)}</span>}
                          {req.completed_at && <span>Completed {fmtTime(req.completed_at)}</span>}
                          {req.cancelled_at && <span>Cancelled {fmtTime(req.cancelled_at)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
