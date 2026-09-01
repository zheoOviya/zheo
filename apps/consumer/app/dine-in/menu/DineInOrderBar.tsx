"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useAuthStore } from "@/lib/store";
import { placeDineInOrder, type DineInOrderDTO } from "@/lib/api";
import { formatINR } from "@/lib/pricing";
import { useDineInStore } from "@/store/dineIn";
import { useDineInSelectionStore } from "@/store/dineInSelection";

// ============================================
// Dine-In order CTA + submission (frozen UI4-A) + placed-order snapshot (UI4-B).
//
// Sticky, mobile-friendly primary CTA rendered whenever a selection exists:
// item count + "Estimated total" (client, non-authoritative) + Place order.
//
// Submission state machine IDLE -> SUBMITTING -> ERROR:
//   - POST /orders with ONLY session_id + { menu_item_id, quantity } lines.
//     No price, GST, total, restaurant/table ids, customizations or token is
//     ever sent — the server is the pricing authority.
//   - Bearer token reuses useAuthStore: in-memory token, else single-flight
//     silent refresh, else the existing /login flow (menu route preserved).
//   - Session-scope guard: submit only when the selection's sessionId equals
//     the active Dine-In context; mismatch reconciles and never POSTs.
//   - Success clears ONLY the selection (context stays, user stays on the menu)
//     and promotes the response DTO into a minimal truthful snapshot. Failure
//     preserves selection + context with safe mapped copy; stale items are
//     never auto-deleted.
//
// UI6-B ordering freeze: a `frozen` prop (driven by the shell's authoritative
// bill snapshot, NOT cached sessionStatus) hides the Place order CTA entirely
// once the bill has been requested. Add/steppers are handled by the menu list;
// the CTA gate here is a second, independent guard so no submission can slip
// through a stale selection after the bill freeze.
//
// Placed-order snapshot (UI4-B): the ONLY source of truth is the successful
// placeOrder response DTO. No GET/history endpoint, no polling, no client-side
// status advancement, no fabricated ETA/order number. Kept component-local
// (the bar is the only consumer for now) and session-scoped: it is cleared
// whenever the Dine-In context changes or clears, so a confirmation never
// leaks across sessions.
// ============================================

type OrderPhase = "idle" | "submitting" | "error";
type OrderErrorKind = "not_found" | "session_closed" | "bill_frozen" | "network";

/** Minimal truthful snapshot — a strict subset of the response DTO. */
interface DineInOrderSnapshot {
  id: string;
  status: string;
  totalAmount: number;
  createdAt: string;
}

const ORDER_ERROR_COPY: Record<
  OrderErrorKind,
  { title: string; body: string; refresh: boolean }
> = {
  not_found: {
    title: "An item is no longer available",
    body: "The menu changed. Refresh the menu and try again.",
    refresh: true,
  },
  session_closed: {
    title: "This dine-in session is no longer accepting orders",
    body: "Ask a staff member for help.",
    refresh: false,
  },
  bill_frozen: {
    title: "The bill has already been requested",
    body: "Your items are being prepared. Ask a staff member for help.",
    refresh: false,
  },
  network: {
    title: "Something went wrong. Try again.",
    body: "We couldn't place your order. Check your connection and try again.",
    refresh: false,
  },
};

// Fixed human-readable labels for the ONLY backend statuses that exist. No
// client-side advancement; anything unmapped simply hides the status line.
const ORDER_STATUS_LABELS: Record<string, string> = {
  PLACED: "Placed",
  PREPARING: "Preparing",
  READY_TO_SERVE: "Ready to serve",
  SERVED: "Served",
  CANCELLED: "Cancelled",
};

function toOrderSnapshot(order: DineInOrderDTO): DineInOrderSnapshot {
  return {
    id: order.id,
    status: order.status,
    totalAmount: order.total_amount,
    createdAt: order.created_at,
  };
}

function classifyOrderError(err: unknown): OrderErrorKind | "auth" {
  const e = err as { status?: number; code?: string };
  if (e.code === "UNAUTHORIZED" || e.status === 401) return "auth";
  if (e.code === "ITEM_NOT_FOUND" || e.status === 404) return "not_found";
  if (e.code === "SESSION_CLOSED_FOR_ORDERING") return "session_closed";
  if (e.code === "BILL_FROZEN") return "bill_frozen";
  return "network";
}

export function DineInOrderBar({
  onRefreshMenu,
  frozen = false,
}: {
  onRefreshMenu: () => void;
  frozen?: boolean;
}) {
  const router = useRouter();
  const { accessToken, refreshAccessToken } = useAuthStore();
  const lines = useDineInSelectionStore((s) => s.lines);
  const contextSessionId = useDineInStore((s) => s.context?.sessionId ?? null);

  const [phase, setPhase] = useState<OrderPhase>("idle");
  const [errorKind, setErrorKind] = useState<OrderErrorKind>("network");
  const [lastSuccess, setLastSuccess] = useState<DineInOrderSnapshot | null>(
    null,
  );
  const submittingRef = useRef(false);

  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const displayTotal = lines.reduce(
    (sum, l) => sum + l.displayPrice * l.quantity,
    0,
  );

  // UI4-B §9: a changed/cleared Dine-In context must never retain the previous
  // session's confirmation snapshot.
  useEffect(() => {
    setLastSuccess(null);
  }, [contextSessionId]);

  // A cleared selection leaves no in-flight submission to explain an error.
  useEffect(() => {
    if (phase === "error" && itemCount === 0) {
      setPhase("idle");
    }
  }, [phase, itemCount]);

  const handlePlaceOrder = useCallback(async () => {
    if (submittingRef.current) return;
    const ctx = useDineInStore.getState().context;
    if (!ctx) return;
    const sel = useDineInSelectionStore.getState();
    if (sel.sessionId !== ctx.sessionId) {
      // Session-scope inconsistency: reconcile to the active context (clears
      // the stale selection) and never submit against a mismatched session.
      sel.ensureScope(ctx.sessionId);
      return;
    }
    const payloadLines = sel.lines.map((l) => ({
      menu_item_id: l.menuItemId,
      quantity: l.quantity,
    }));
    if (payloadLines.length === 0) return;

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
        setPhase("idle");
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      const outcome = await placeDineInOrder(
        ctx.sessionId,
        payloadLines,
        currentToken,
      );
      // Success (UI4-B §4/§7): the latest success REPLACES the previous
      // snapshot. Only the selection is cleared — the Dine-In context stays and
      // the user remains on the menu route (additive orders stay possible).
      setLastSuccess(toOrderSnapshot(outcome.order));
      useDineInSelectionStore.getState().clear();
      useDineInSelectionStore.getState().ensureScope(ctx.sessionId);
      setPhase("idle");
    } catch (err) {
      const kind = classifyOrderError(err);
      if (kind === "auth") {
        setPhase("idle");
        router.push(`/login?from=${encodeURIComponent("/dine-in/menu")}`);
        return;
      }
      setErrorKind(kind);
      setPhase("error");
    } finally {
      submittingRef.current = false;
    }
  }, [accessToken, refreshAccessToken, router]);

  const handleRefreshMenu = useCallback(() => {
    setPhase("idle");
    onRefreshMenu();
  }, [onRefreshMenu]);

  const error = phase === "error" ? ORDER_ERROR_COPY[errorKind] : null;
  const statusLabel = lastSuccess
    ? ORDER_STATUS_LABELS[lastSuccess.status]
    : undefined;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {lastSuccess && (
        <div
          role="status"
          className="mx-auto mb-2 w-full max-w-md rounded-3xl bg-green-500/10 p-4 text-center"
        >
          <CheckCircleIcon
            className="mx-auto h-8 w-8 text-green-600"
            aria-hidden="true"
          />
          <p className="mt-1 text-sm font-bold text-green-700">Order placed</p>
          {statusLabel && (
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              Status: {statusLabel}
            </p>
          )}
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            Order total: {formatINR(lastSuccess.totalAmount)}
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mx-auto mb-2 w-full max-w-md rounded-2xl bg-red-50 p-3 dark:bg-red-950/40"
        >
          <p className="text-xs font-bold text-red-600">{error.title}</p>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            {error.body}
          </p>
          {error.refresh && (
            <button
              type="button"
              onClick={handleRefreshMenu}
              className="btn-primary mt-2 min-h-[44px] w-full"
            >
              Refresh menu
            </button>
          )}
        </div>
      )}

      {!frozen && itemCount > 0 && (
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-3xl bg-white p-3 shadow-elevation-3 dark:bg-neutral-900">
          <div className="min-w-0">
            <p className="text-xs font-bold text-primary-700 dark:text-primary-300">
              {itemCount} item{itemCount === 1 ? "" : "s"} selected
            </p>
            <p className="text-2xs text-neutral-500 dark:text-neutral-400">
              Estimated total: {formatINR(displayTotal)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handlePlaceOrder()}
            disabled={phase === "submitting"}
            aria-disabled={phase === "submitting"}
            className="btn-primary min-h-[44px] shrink-0 px-5"
          >
            {phase === "submitting" ? "Placing order..." : "Place order"}
          </button>
        </div>
      )}
    </div>
  );
}
