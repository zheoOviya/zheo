"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircleIcon,
  DocumentTextIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useAuthStore } from "@/lib/store";
import { requestDineInBill } from "@/lib/api";
import { formatINR } from "@/lib/pricing";
import { useDineInStore } from "@/store/dineIn";
import { useDialogFocus } from "@/hooks/useDialogFocus";

// ============================================
// Dine-In request bill: confirmation + authoritative bill display (UI6-B).
//
// Menu-level entry ("Request bill") in the menu header/shell area, SEPARATE
// from the service-request panel ("Need something?"). BRING_BILL is never
// created through the generic service-request API — the billing route owns
// that artifact internally.
//
// Flow: IDLE -> CONFIRMING -> SUBMITTING -> SUCCESS | ERROR.
//   - The first tap opens a small confirmation dialog that makes the freeze
//     consequence explicit. NO mutation happens before confirm.
//   - Confirm -> POST /sessions/:sessionId/bill with NO body and Bearer auth
//     (the route computes the bill from persisted snapshots). One concurrent
//     POST max (synchronous ref guard + disabled controls while in flight).
//   - On success the ONLY server response becomes the current bill truth:
//     the session status is required to be a frozen billing status
//     (BILL_REQUESTED, or PAYMENT_PENDING as an idempotent read). The bill
//     panel shows the authoritative DTO breakdown — never a client-computed
//     estimate, never client GST/payable math.
//   - Repeated requests are safe: requestBill is server-idempotent, so a retry
//     after an uncertain network result may re-POST; a repeat returns the
//     existing bill and REPLACES the single bill panel (never appended).
//   - Ordering freeze is driven by the shell's bill state, not by caching a
//     pre-request sessionStatus: once a bill snapshot is accepted, Add /
//     steppers / Place order are disabled for the current SPA session.
//
// Component-local only: the snapshot holds session status + the six display
// amounts. No bill id, session/restaurant/table ids, timestamps, or
// bringBillRequest internals are retained or rendered. No storage, no
// polling/readback, no payment/D-PAY behavior.
// ============================================

export interface DineInBillSnapshot {
  sessionStatus: string;
  foodSubtotal: number;
  gstFood: number;
  gstPackaging: number;
  packagingFee: number;
  totalAmount: number;
}

const EXPECTED_FROZEN_STATUSES = ["BILL_REQUESTED", "PAYMENT_PENDING"];

type BillErrorKind =
  | "not_found"
  | "not_billable"
  | "invariant"
  | "network";

const BILL_ERROR_COPY: Record<BillErrorKind, string> = {
  not_found: "We couldn't find your session. Scan the table QR again.",
  not_billable: "A bill can't be requested for this session right now.",
  invariant: "Something went wrong. Try again.",
  network: "Something went wrong. Try again.",
};

function classifyBillError(err: unknown): BillErrorKind | "auth" {
  const e = err as { status?: number; code?: string };
  if (e.code === "UNAUTHORIZED" || e.status === 401) return "auth";
  if (e.code === "SESSION_NOT_FOUND") return "not_found";
  if (e.code === "SESSION_NOT_BILLABLE") return "not_billable";
  if (e.code === "BILL_INVARIANT_VIOLATION") return "invariant";
  return "network";
}

export function DineInBillRequestPanel({
  sessionId,
  bill,
  onBillReceived,
}: {
  sessionId: string;
  bill: DineInBillSnapshot | null;
  onBillReceived: (snapshot: DineInBillSnapshot) => void;
}) {
  const router = useRouter();
  const { accessToken, refreshAccessToken } = useAuthStore();
  const contextSessionId = useDineInStore((s) => s.context?.sessionId ?? null);

  // null = dialog closed. confirming/submitting/error keep the dialog open so
  // the freeze consequence stays visible and retry is one tap away.
  const [phase, setPhase] = useState<"confirming" | "submitting" | "error" | null>(
    null,
  );
  const [errorKind, setErrorKind] = useState<BillErrorKind>("network");
  const submittingRef = useRef(false);

  // A changed/cleared Dine-In context must close the confirmation safely; the
  // bill panel itself is driven by the shell's bill prop and unmounts when the
  // context is lost (empty-context fallback).
  useEffect(() => {
    if (phase !== null && contextSessionId !== sessionId) {
      submittingRef.current = false;
      setPhase(null);
    }
  }, [phase, contextSessionId, sessionId]);

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    const ctx = useDineInStore.getState().context;
    if (!ctx) return;

    submittingRef.current = true;
    setPhase("submitting");
    try {
      // Auth: reuse the in-memory token, else the single-flight silent
      // refresh, else the existing /login flow with the menu route preserved.
      let currentToken = accessToken;
      if (!currentToken) {
        const refreshed = await refreshAccessToken();
        currentToken = refreshed ? useAuthStore.getState().accessToken : null;
      }
      if (!currentToken) {
        setPhase(null);
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      const outcome = await requestDineInBill(ctx.sessionId, currentToken);

      // Success authority: accept ONLY an expected frozen billing status.
      const status = outcome.session.status;
      if (!EXPECTED_FROZEN_STATUSES.includes(status)) {
        // Contract breach from the server: fail safe, no freeze, no payment
        // interpretation.
        setErrorKind("network");
        setPhase("error");
        return;
      }
      // Only the server response becomes the current bill truth. The snapshot
      // keeps the six display fields; ids/timestamps/bringBillRequest internals
      // are deliberately discarded.
      onBillReceived({
        sessionStatus: status,
        foodSubtotal: outcome.bill.food_subtotal,
        gstFood: outcome.bill.gst_food,
        gstPackaging: outcome.bill.gst_packaging,
        packagingFee: outcome.bill.packaging_fee,
        totalAmount: outcome.bill.total_amount,
      });
      setPhase(null);
    } catch (err) {
      const kind = classifyBillError(err);
      if (kind === "auth") {
        setPhase(null);
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      setErrorKind(kind);
      setPhase("error");
    } finally {
      submittingRef.current = false;
    }
  }, [accessToken, refreshAccessToken, router, onBillReceived]);

  const inFlight = phase === "submitting";
  const error = phase === "error" ? BILL_ERROR_COPY[errorKind] : null;
  // UI7-B Repair C: initial focus, Tab containment, Escape-to-close (ignored
  // while submitting), focus restore, body scroll lock. UI7-B Repair B:
  // viewport-constrained panel (100dvh tracks the OS keyboard) with internal
  // scroll so the confirm/keep-ordering actions stay reachable.
  const dialogRef = useDialogFocus({
    open: phase !== null,
    onEscape: () => setPhase(null),
    escapeDisabled: inFlight,
  });

  return (
    <>
      {bill && (
        <div
          role="status"
          className="rounded-2xl bg-green-500/10 p-4 text-center"
        >
          <CheckCircleIcon
            className="mx-auto h-8 w-8 text-green-600"
            aria-hidden="true"
          />
          <p className="mt-1 text-sm font-bold text-green-700">
            {bill.sessionStatus === "PAYMENT_PENDING" ? "Bill" : "Bill requested"}
          </p>
          <dl className="mt-3 space-y-1.5 text-left text-xs">
            <div className="flex items-center justify-between text-neutral-700 dark:text-neutral-300">
              <dt>Food subtotal</dt>
              <dd className="font-semibold">{formatINR(bill.foodSubtotal)}</dd>
            </div>
            <div className="flex items-center justify-between text-neutral-700 dark:text-neutral-300">
              <dt>GST</dt>
              <dd className="font-semibold">{formatINR(bill.gstFood)}</dd>
            </div>
            {bill.packagingFee > 0 && (
              <div className="flex items-center justify-between text-neutral-700 dark:text-neutral-300">
                <dt>Packaging</dt>
                <dd className="font-semibold">{formatINR(bill.packagingFee)}</dd>
              </div>
            )}
            {bill.gstPackaging > 0 && (
              <div className="flex items-center justify-between text-neutral-700 dark:text-neutral-300">
                <dt>Packaging GST</dt>
                <dd className="font-semibold">
                  {formatINR(bill.gstPackaging)}
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-green-600/20 pt-1.5 text-sm font-extrabold text-green-700">
              <dt>Total</dt>
              <dd>{formatINR(bill.totalAmount)}</dd>
            </div>
          </dl>
        </div>
      )}

      <button
        type="button"
        onClick={() => setPhase("confirming")}
        className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-bold text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
      >
        <DocumentTextIcon className="h-4 w-4" aria-hidden="true" />
        Request bill
      </button>

      {phase !== null && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              if (!inFlight) setPhase(null);
            }}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Request the bill"
            tabIndex={-1}
            className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-elevation-3 dark:bg-neutral-900"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-extrabold text-neutral-900 dark:text-white">
                Request the bill?
              </h2>
              <button
                type="button"
                onClick={() => {
                  if (!inFlight) setPhase(null);
                }}
                aria-label="Close"
                className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <XMarkIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Requesting the bill will stop new orders for this session.
            </p>

            {error && (
              <div
                role="alert"
                className="mt-3 rounded-2xl bg-red-50 p-3 dark:bg-red-950/40"
              >
                <p className="text-xs font-bold text-red-600">{error}</p>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  You can try again.
                </p>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={inFlight}
                aria-disabled={inFlight}
                className="btn-primary min-h-[44px] w-full"
              >
                {inFlight ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <svg
                      className="h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Requesting bill...
                  </span>
                ) : (
                  "Request bill"
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!inFlight) setPhase(null);
                }}
                disabled={inFlight}
                aria-disabled={inFlight}
                className="min-h-[44px] w-full rounded-2xl border border-neutral-200 bg-white text-sm font-bold text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                Keep ordering
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
