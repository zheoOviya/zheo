"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  QrCodeIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import {
  openDineInSession,
  resolveDineInTable,
  type DiningSessionDTO,
  type TableResolveResult,
} from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useDineInStore, type DineInSessionStatus } from "@/store/dineIn";
import { Skeleton } from "@snakzap/ui";

// ============================================
// Dine-in QR resolution + session entry (frozen UI1-B1 + UI1-B2).
//
// State machine: INITIAL -> RESOLVING -> RESOLVED | ERROR.
//   - missing/empty token: -> ERROR immediately (no API call)
//   - valid token: -> one public GET resolve call, then RESOLVED
//
// Session entry (RESOLVED only, explicit user click, auth required):
//   RESOLVED -> OPENING_SESSION -> SESSION_READY | OPEN_ERROR
// A session is NEVER auto-opened by a successful resolve. The same opaque
// token goes to POST /sessions as table_token; the client never generates or
// depends on restaurant/table ids. Duplicate clicks are blocked by a ref
// guard + disabled button while in flight.
//
// Auth reuses the existing consumer pattern: in-memory access token, or the
// single-flight silent refresh, then /login?from=<destination> if still
// anonymous. No second auth system.
//
// SESSION_READY (frozen UI1-B5): after the context store is populated, an
// explicit "View Menu" action navigates to /dine-in/menu (a fixed, token-free
// URL). No auto-navigation on session creation. The opaque token stays in the
// pre-open URL only and never travels to the menu route.
// ============================================

type Phase = "resolving" | "resolved" | "error";
type ErrorKind = "invalid" | "not_found" | "network";
type OpenPhase = "idle" | "opening" | "ready" | "error";
type OpenErrorKind = "unauthorized" | "not_found" | "occupied" | "network";

function classifyError(err: unknown): ErrorKind {
  const e = err as { status?: number; code?: string };
  if (e.code === "TABLE_NOT_FOUND" || e.status === 404) return "not_found";
  if (e.code === "VALIDATION_ERROR" || e.status === 400) return "invalid";
  return "network";
}

function classifyOpenError(err: unknown): OpenErrorKind {
  const e = err as { status?: number; code?: string };
  if (e.code === "UNAUTHORIZED" || e.status === 401) return "unauthorized";
  if (e.code === "TABLE_NOT_FOUND" || e.status === 404) return "not_found";
  if (e.code === "TABLE_OCCUPIED" || e.status === 409) return "occupied";
  return "network";
}

const OPEN_ERROR_COPY: Record<
  "not_found" | "occupied" | "network",
  { title: string; body: string }
> = {
  not_found: {
    title: "Table not found or unavailable",
    body: "The table changed since you scanned it. Re-scan the QR code or ask a staff member for help.",
  },
  occupied: {
    title: "This table is already in use",
    body: "Someone else is seated here. Ask a staff member for help.",
  },
  network: {
    title: "Something went wrong. Try again.",
    body: "We couldn't open your session. Check your connection and try again.",
  },
};

export function DineInResolver({ token }: { token: string | null }) {
  const router = useRouter();
  const { accessToken, isAuthenticated, refreshAccessToken } = useAuthStore();

  const [phase, setPhase] = useState<Phase>("resolving");
  const [errorKind, setErrorKind] = useState<ErrorKind>("network");
  const [result, setResult] = useState<TableResolveResult | null>(null);
  const [openPhase, setOpenPhase] = useState<OpenPhase>("idle");
  const [openErrorKind, setOpenErrorKind] = useState<
    "not_found" | "occupied" | "network"
  >("network");
  const [session, setSession] = useState<DiningSessionDTO | null>(null);
  const openingRef = useRef(false);

  // Silent session hydration on this public page (same pattern as the gift
  // page): a returning user with a valid refresh cookie is quietly
  // re-authenticated so Continue does not bounce them to /login.
  useEffect(() => {
    if (isAuthenticated) return;
    void refreshAccessToken().catch(() => undefined);
  }, [isAuthenticated, refreshAccessToken]);

  const load = useCallback(async () => {
    if (!token) {
      setPhase("error");
      setErrorKind("invalid");
      return;
    }
    setPhase("resolving");
    setResult(null);
    try {
      setResult(await resolveDineInTable(token));
      setPhase("resolved");
    } catch (err) {
      setErrorKind(classifyError(err));
      setPhase("error");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const loginHref = token
    ? `/login?from=${encodeURIComponent(`/dine-in?table=${encodeURIComponent(token)}`)}`
    : "/login";

  async function handleOpenSession() {
    if (openingRef.current) return;
    if (!token) return;

    // Auth gate (UI1-B2): reuse the in-memory access token; if absent, attempt
    // the existing silent refresh before bouncing to login. POST /sessions
    // only ever fires for an authenticated caller.
    let currentToken = accessToken;
    if (!currentToken) {
      try {
        const refreshed = await refreshAccessToken();
        currentToken = refreshed ? useAuthStore.getState().accessToken : null;
      } catch {
        currentToken = null;
      }
    }
    if (!currentToken) {
      router.push(loginHref);
      return;
    }

    openingRef.current = true;
    setOpenPhase("opening");
    try {
      const outcome = await openDineInSession(token, currentToken);
      const resolved = result;
      if (!resolved) {
        // Defensive: RESOLVED must have completed before open is possible.
        setOpenErrorKind("network");
        setOpenPhase("error");
        return;
      }
      // Authority consistency (frozen UI1-B4): the authoritative session must
      // agree with the trusted resolve result. On mismatch, fail closed —
      // never store a context that disagrees with the backend.
      if (
        outcome.session.restaurant_id !== resolved.restaurant.id ||
        outcome.session.table_id !== resolved.table.id
      ) {
        setOpenErrorKind("network");
        setOpenPhase("error");
        return;
      }
      // Populate the minimal navigation context (B3 contract). Only trusted
      // display data + session identity; no token, no timestamps, no owner.
      useDineInStore.getState().setContext({
        sessionId: outcome.session.id,
        restaurant: {
          id: resolved.restaurant.id,
          name: resolved.restaurant.name,
        },
        table: { id: resolved.table.id, label: resolved.table.label },
        sessionStatus: outcome.session.status as DineInSessionStatus,
      });
      setSession(outcome.session);
      setOpenPhase("ready");
    } catch (err) {
      const kind = classifyOpenError(err);
      if (kind === "unauthorized") {
        // Stale/invalid token: existing auth flow decides (login, preserving
        // the /dine-in?table=... destination).
        router.push(loginHref);
        return;
      }
      setOpenErrorKind(kind);
      setOpenPhase("error");
    } finally {
      openingRef.current = false;
    }
  }

  if (phase === "resolving") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-elevation-2 dark:bg-neutral-900">
          <div
            aria-hidden="true"
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500/10"
          >
            <QrCodeIcon className="h-7 w-7 text-primary-600 dark:text-primary-400" />
          </div>
          <p className="mt-4 text-sm font-semibold text-neutral-500 dark:text-neutral-400">
            Checking your table...
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-12 w-full" />
          </div>
        </div>
      </main>
    );
  }

  if (phase === "error") {
    const ERROR_COPY: Record<
      ErrorKind,
      { title: string; body: string; retry: boolean }
    > = {
      invalid: {
        title: "Invalid table QR",
        body: "This link is missing a valid table code. Scan the QR code on your table to get started.",
        retry: false,
      },
      not_found: {
        title: "Table not found or unavailable",
        body: "This table may no longer be active. Re-scan the QR code or ask a staff member for help.",
        retry: true,
      },
      network: {
        title: "Something went wrong. Try again.",
        body: "We couldn't check your table. Check your connection and try again.",
        retry: true,
      },
    };
    const copy = ERROR_COPY[errorKind];

    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-elevation-2 dark:bg-neutral-900">
          <XCircleIcon className="mx-auto h-10 w-10 text-red-500" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-bold text-neutral-900 dark:text-white">
            {copy.title}
          </h1>
          <p role="alert" className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {copy.body}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            {copy.retry && (
              <button
                type="button"
                onClick={() => void load()}
                className="btn-primary min-h-[44px] w-full"
              >
                Try again
              </button>
            )}
            <Link href="/" className="btn-primary mt-1 min-h-[44px] w-full">
              Back to Home
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const { restaurant, table } = result!;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-primary-600 via-primary-500 to-primary-700 p-6">
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-elevation-3 dark:bg-neutral-900">
        <div className="relative h-36 bg-primary-100 dark:bg-primary-900/30">
          <span
            aria-hidden="true"
            className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur"
          >
            <QrCodeIcon className="h-5 w-5" />
          </span>
          <div className="absolute bottom-3 left-4 right-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/80">
              Dine-in
            </p>
            <p className="truncate text-lg font-extrabold">{restaurant.name}</p>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Your table
              </p>
              <h1 className="mt-0.5 text-2xl font-extrabold text-neutral-900 dark:text-white">
                {table.label}
              </h1>
            </div>
            <span className="shrink-0 rounded-full bg-green-500/10 px-3 py-1 text-xs font-bold text-green-700">
              Ready to order
            </span>
          </div>

          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            You are seated at {table.label} at {restaurant.name}. Ordering is
            ready when you are.
          </p>

          {openPhase === "idle" && (
            <>
              <button
                type="button"
                onClick={() => void handleOpenSession()}
                className="mt-5 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm"
              >
                Continue <ArrowRightIcon className="h-4 w-4" />
              </button>
              <p className="mt-2 text-center text-xs text-neutral-400">
                Opens your table session.
              </p>
            </>
          )}

          {openPhase === "opening" && (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="mt-5 flex min-h-[48px] w-full cursor-not-allowed items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white opacity-70"
            >
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Opening session...
            </button>
          )}

          {openPhase === "ready" && session && (
            <div className="mt-5 rounded-2xl bg-green-500/10 p-4 text-center">
              <CheckCircleIcon className="mx-auto h-8 w-8 text-green-600" aria-hidden="true" />
              <div role="status">
                <p className="mt-1 text-sm font-bold text-green-700">Session ready</p>
                <p className="mt-1 text-xs text-neutral-500">
                  You&apos;re all set at {table.label} at {restaurant.name}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => router.push("/dine-in/menu")}
                className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-2.5 text-sm font-bold text-white shadow-sm"
              >
                View Menu <ArrowRightIcon className="h-4 w-4" />
              </button>
            </div>
          )}

          {openPhase === "error" && (
            <div className="mt-5 rounded-2xl bg-red-50 p-4 text-center dark:bg-red-950/40">
              <XCircleIcon className="mx-auto h-8 w-8 text-red-500" aria-hidden="true" />
              <p role="alert" className="mt-1 text-sm font-bold text-red-600">
                {OPEN_ERROR_COPY[openErrorKind].title}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {OPEN_ERROR_COPY[openErrorKind].body}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void handleOpenSession()}
                  className="btn-primary min-h-[44px] w-full"
                >
                  Try again
                </button>
                <Link href="/" className="btn-primary mt-1 min-h-[44px] w-full">
                  Back to Home
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
