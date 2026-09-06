"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  PageHeader,
  ErrorBanner,
  Spinner,
  EmptyPanel,
  SecondaryButton,
} from "@/components/ui";
import {
  fetchVendorBillDetail,
  type VendorBillDetail,
} from "@/lib/api";
import { billDetailStatusMeta, billGstTotal, hasPackagingFee, isDeliveredBill } from "@/lib/dineInBills";
import { formatINR, formatDateTime, shortOrderId } from "@/lib/format";

function LifecycleChip({ status }: { status: "PENDING" | "ACKNOWLEDGED" | "COMPLETED" }) {
  const meta = billDetailStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium tabular-nums text-slate-900">{value}</span>
    </p>
  );
}

function MoneyRow({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  return (
    <p
      className={`flex items-baseline justify-between gap-4 ${
        total ? "border-t border-slate-200 pt-2" : ""
      }`}
    >
      <span className={`text-sm ${total ? "font-bold text-slate-900" : "text-slate-500"}`}>
        {label}
      </span>
      <span
        className={`font-mono tabular-nums ${
          total ? "text-base font-bold text-slate-900" : "text-sm font-medium text-slate-900"
        }`}
      >
        {value}
      </span>
    </p>
  );
}

export default function VendorBillDetailPage() {
  const params = useParams<{ billId: string }>();
  const billId = params.billId;
  const [detail, setDetail] = useState<VendorBillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      const data = await fetchVendorBillDetail(billId);
      setDetail(data);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load the bill");
    } finally {
      setLoading(false);
    }
  }, [billId]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  if (loading && !detail) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (fetchError !== "" && !detail) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Bill not available"
          actions={
            <Link
              href="/dine-in/bills"
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
            >
              Back to bills
            </Link>
          }
        />
        <ErrorBanner message={fetchError} />
        <EmptyPanel
          title="Couldn't load the bill"
          description="The bill may no longer be available. Try again or return to the bill queue."
          cta={
            <SecondaryButton onClick={retry} className="min-w-28">
              Try again
            </SecondaryButton>
          }
        />
      </div>
    );
  }

  if (!detail) return null;

  const delivered = isDeliveredBill(detail);
  const lifecycleStatus = detail.bring_bill_request?.status;
  const zoneName = detail.zone?.name ?? null;
  const billNoun = `#${shortOrderId(detail.bill.id)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Bill ${billNoun}`}
        subtitle={`${detail.table.label}${zoneName ? ` · ${zoneName}` : ""} · session #${shortOrderId(
          detail.session.id,
        )}`}
        actions={
          <>
            <Link
              href="/dine-in/bills"
              className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
            >
              Back to bills
            </Link>
            <SecondaryButton onClick={() => window.print()}>Print bill</SecondaryButton>
          </>
        }
      />

      {/* The only print surface on this route. Print button, PageHeader and
          navigation sit outside #bill-print-region so a print of the bill
          contains the frozen bill content alone (scoped in globals.css). */}
      <div id="bill-print-region" className="space-y-5">
        {delivered && (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800"
          >
            Delivered to the table. This bill is complete and can only be viewed here.
          </div>
        )}

        <section aria-label="Bill summary" className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-bold text-slate-700">Bill {billNoun}</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {detail.table.label}
                {zoneName ? `, ${zoneName}` : ""} · session #{shortOrderId(detail.session.id)}
              </p>
            </div>
            {lifecycleStatus && <LifecycleChip status={lifecycleStatus} />}
          </header>

          <dl className="space-y-1.5 px-4 py-4">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="text-sm text-slate-500">Requested</dt>
              <dd className="font-mono text-sm text-slate-700 tabular-nums">
                {formatDateTime(detail.session.bill_requested_at)}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="text-sm text-slate-500">Frozen</dt>
              <dd className="font-mono text-sm text-slate-700 tabular-nums">
                {formatDateTime(detail.bill.frozen_at)}
              </dd>
            </div>
            {detail.bring_bill_request?.acknowledged_at && (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <dt className="text-sm text-slate-500">Acknowledged</dt>
                <dd className="font-mono text-sm text-slate-700 tabular-nums">
                  {formatDateTime(detail.bring_bill_request.acknowledged_at)}
                </dd>
              </div>
            )}
            {detail.bring_bill_request?.completed_at && (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <dt className="text-sm text-slate-500">Delivered</dt>
                <dd className="font-mono text-sm text-slate-700 tabular-nums">
                  {formatDateTime(detail.bring_bill_request.completed_at)}
                </dd>
              </div>
            )}
          </dl>
        </section>

        {detail.orders.map((order) => (
          <section
            key={order.id}
            aria-label={`Order ${shortOrderId(order.id)}`}
            className="rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-bold text-slate-700">Order #{shortOrderId(order.id)}</h3>
              <p className="text-xs text-slate-400">Placed {formatDateTime(order.created_at)}</p>
            </header>
            <ul className="divide-y divide-slate-100">
              {order.items.map((item, index) => (
                <li
                  key={`${order.id}-${index}`}
                  className="flex items-start justify-between gap-3 px-4 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="break-words text-slate-800">{item.name}</p>
                    <p className="text-xs text-slate-400">× {item.quantity}</p>
                  </div>
                  <span className="shrink-0 font-mono text-slate-700 tabular-nums">
                    {formatINR(item.item_subtotal)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section aria-label="Bill totals" className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
          <div className="space-y-1.5">
            <SummaryLine label="Food subtotal" value={formatINR(detail.bill.food_subtotal)} />
            {hasPackagingFee(detail.bill) && (
              <SummaryLine label="Packaging fee" value={formatINR(detail.bill.packaging_fee)} />
            )}
            <SummaryLine label="GST" value={formatINR(billGstTotal(detail.bill))} />
            <MoneyRow label="Total" value={formatINR(detail.bill.total_amount)} total />
          </div>
        </section>
      </div>
    </div>
  );
}
