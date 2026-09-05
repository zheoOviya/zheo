"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader, ErrorBanner, Spinner, EmptyPanel, StatCard } from "@/components/ui";
import { useActiveRestaurant } from "@/hooks/useActiveRestaurant";
import { fetchDineInTables, type VendorTableBoardRow } from "@/lib/api";
import {
  DISABLED_TABLE_META,
  FREE_TABLE_STATUS_META,
  deriveBoardSummary,
  isTableFree,
  shortSessionId,
  tableSessionStatusMeta,
} from "@/lib/dineInTables";
import { relativeTime } from "@/lib/format";

function SessionChip({ session }: { session: NonNullable<VendorTableBoardRow["session"]> }) {
  const meta = tableSessionStatusMeta(session.status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function FreeChip() {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${FREE_TABLE_STATUS_META.badge}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${FREE_TABLE_STATUS_META.dot}`}
        aria-hidden="true"
      />
      {FREE_TABLE_STATUS_META.label}
    </span>
  );
}

function DisabledPill() {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${DISABLED_TABLE_META.badge}`}
    >
      {DISABLED_TABLE_META.label}
    </span>
  );
}

export default function DineInTableBoardPage() {
  const [rows, setRows] = useState<VendorTableBoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const restaurantGenerationRef = useRef(0);

  const { activeRestaurantId } = useActiveRestaurant();

  useEffect(() => {
    const restaurantId = activeRestaurantId;
    if (!restaurantId) return;
    const generation = restaurantGenerationRef.current + 1;
    restaurantGenerationRef.current = generation;
    let stale = false;
    setRows([]);
    setFetchError("");
    setLoading(true);

    async function load(rid: string) {
      try {
        const data = await fetchDineInTables(rid);
        if (stale) return;
        setRows(data);
        setFetchError("");
      } catch (err) {
        if (stale) return;
        setFetchError(err instanceof Error ? err.message : "Failed to load the table board");
      } finally {
        if (!stale) setLoading(false);
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

  if (!activeRestaurantId || (loading && rows.length === 0)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const summary = deriveBoardSummary(rows);
  const tableNoun = summary.total === 1 ? "table" : "tables";
  const requestNoun =
    summary.openRequests === 1 ? "open request" : "open requests";
  const srBoardText =
    fetchError !== "" && rows.length === 0
      ? "Table board unavailable"
      : summary.total === 0
        ? "No tables on the board"
        : `${summary.occupied} of ${summary.total} ${tableNoun} occupied${
            summary.openRequests > 0 ? `, ${summary.openRequests} ${requestNoun}` : ""
          }`;

  const showRetryPanel = fetchError !== "" && rows.length === 0 && !loading;
  const showEmptyState = fetchError === "" && rows.length === 0 && !loading;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Table Board"
        subtitle={`${summary.total} ${tableNoun} · ${summary.occupied} occupied, ${summary.free} free`}
        actions={
          <Link
            href="/dine-in"
            className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-[0.98]"
          >
            Orders &amp; requests
          </Link>
        }
      />

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {srBoardText}
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total tables" value={String(summary.total)} accent="teal" />
        <StatCard label="Occupied" value={String(summary.occupied)} accent="blue" />
        <StatCard label="Free" value={String(summary.free)} accent="green" />
        <StatCard label="Open requests" value={String(summary.openRequests)} accent="amber" />
      </div>

      {fetchError !== "" && rows.length > 0 && <ErrorBanner message={fetchError} />}

      {showRetryPanel ? (
        <EmptyPanel
          title="Couldn't load the table board"
          description="The board will keep retrying. Table occupancy should appear here."
        />
      ) : showEmptyState ? (
        <EmptyPanel
          title="No tables yet"
          description="Tables configured for this restaurant will appear here."
        />
      ) : (
        <ul role="list" aria-label="Table board" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const free = isTableFree(row);
            const meta = row.session ? tableSessionStatusMeta(row.session.status) : null;
            const seatCount = row.table.seat_count;
            const disabled = !row.table.is_active;

            return (
              <li
                key={row.table.id}
                aria-label={`Table ${row.table.label}${row.zone ? `, ${row.zone.name}` : ""}, ${
                  free ? "free" : meta ? meta.label.toLowerCase() : "occupied"
                }${disabled ? ", disabled" : ""}`}
                className={`flex flex-col rounded-xl border p-4 shadow-sm transition-colors ${
                  disabled ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p
                      className={`truncate text-base font-bold ${
                        disabled ? "text-slate-500" : "text-slate-900"
                      }`}
                      title={row.table.label}
                    >
                      {row.table.label}
                    </p>
                    {(row.zone || seatCount !== null) && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        {row.zone && (
                          <span className="font-semibold text-slate-600">{row.zone.name}</span>
                        )}
                        {row.zone && seatCount !== null && (
                          <span className="mx-1.5" aria-hidden="true">
                            ·
                          </span>
                        )}
                        {seatCount !== null &&
                          `${seatCount} ${seatCount === 1 ? "seat" : "seats"}`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {row.session ? <SessionChip session={row.session} /> : <FreeChip />}
                    {disabled && <DisabledPill />}
                  </div>
                </div>

                {row.session && (
                  <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-500">
                    <p>
                      <span className="font-mono font-semibold text-slate-600">
                        #{shortSessionId(row.session.id)}
                      </span>
                      <span className="mx-1.5" aria-hidden="true">
                        ·
                      </span>
                      Opened {relativeTime(row.session.opened_at)}
                      {row.session.bill_requested_at && (
                        <>
                          <span className="mx-1.5" aria-hidden="true">
                            ·
                          </span>
                          Bill requested {relativeTime(row.session.bill_requested_at)}
                        </>
                      )}
                    </p>
                    {(row.open_order_count > 0 || row.open_request_count > 0) && (
                      <p>
                        {row.open_order_count} open{" "}
                        {row.open_order_count === 1 ? "order" : "orders"}
                        <span className="mx-1.5" aria-hidden="true">
                          ·
                        </span>
                        {row.open_request_count} open{" "}
                        {row.open_request_count === 1 ? "request" : "requests"}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
