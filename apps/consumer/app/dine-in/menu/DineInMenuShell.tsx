"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { QrCodeIcon } from "@heroicons/react/24/outline";
import { useDineInStore } from "@/store/dineIn";
import { useDineInSelectionStore } from "@/store/dineInSelection";
import { DineInMenuList } from "./DineInMenuList";
import { DineInServiceRequestPanel } from "./DineInServiceRequestPanel";
import {
  DineInBillRequestPanel,
  type DineInBillSnapshot,
} from "./DineInBillRequestPanel";

// ============================================
// Dine-In menu shell + context guard (frozen UI1-B5).
//
// VALID CONTEXT PATH: renders only trusted cached display data —
// restaurant.name, table.label, "Dine-In Menu" heading. No session id, no
// restaurant/table id, no raw session status, no token. It does NOT claim the
// session is still authoritative (no backend revalidation exists yet).
//
// EMPTY CONTEXT PATH (cold reload / direct navigation): memory store is empty.
// Explicit safe fallback with re-scan guidance — never a fabricated menu/session,
// and never a silent redirect into the missing-token error loop.
//
// VALID CONTEXT PATH (frozen UI2-B1): renders the trusted restaurant/table
// header and delegates the catalog to <DineInMenuList>, which fetches
// fetchRestaurantMenu(context.restaurant.id) once on mount. No menu fetch
// happens when the store is empty. No cart, no order/session mutation.
// ============================================

export function DineInMenuShell() {
  const context = useDineInStore((s) => s.context);

  // UI6-B: the authoritative bill snapshot lives in the shell as separate
  // view state — it is NEVER cached into useDineInStore.sessionStatus. The
  // same snapshot drives both the bill card and the ordering freeze below.
  const [bill, setBill] = useState<DineInBillSnapshot | null>(null);

  const sessionId = context?.sessionId ?? null;
  // A bill belongs to one session: changing or clearing the Dine-In context
  // resets the snapshot so a freeze never leaks into another session.
  useEffect(() => {
    setBill(null);
  }, [sessionId]);

  // UI3-B session-scope wiring (menu layer only, stores stay decoupled):
  // when the Dine-In context is absent/cleared (cold reload / re-scan path),
  // the selection for that session is dropped too.
  useEffect(() => {
    if (!context) {
      useDineInSelectionStore.getState().clear();
    }
  }, [context]);

  // UI6-B: a successful, authoritative bill response becomes the current bill
  // truth. It also clears the unsubmitted selection (never part of the frozen
  // bill) and re-adopts the session scope for consistency.
  const handleBillReceived = useCallback((snapshot: DineInBillSnapshot) => {
    const ctx = useDineInStore.getState().context;
    setBill(snapshot);
    if (ctx) {
      useDineInSelectionStore.getState().clear();
      useDineInSelectionStore.getState().ensureScope(ctx.sessionId);
    }
  }, []);

  if (!context) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-elevation-2 dark:bg-neutral-900">
          <div
            aria-hidden="true"
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500/10"
          >
            <QrCodeIcon className="h-7 w-7 text-primary-600 dark:text-primary-400" />
          </div>
          <h1 className="mt-4 text-lg font-bold text-neutral-900 dark:text-white">
            Dine-in session unavailable
          </h1>
          <p role="alert" className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Your dine-in session isn&apos;t available on this device page. Scan
            the table QR again.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link href="/dine-in" className="btn-primary min-h-[44px] w-full">
              Scan table QR again
            </Link>
          </div>
          <p className="mt-3 text-xs text-neutral-400">
            The QR code on your table re-opens your session on this device.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-primary-600 via-primary-500 to-primary-700 p-6">
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-elevation-3 dark:bg-neutral-900">
        <div className="relative h-32 bg-primary-100 dark:bg-primary-900/30">
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
            <p className="truncate text-lg font-extrabold">{context.restaurant.name}</p>
          </div>
        </div>

        <div className="p-6">
          <h1 className="text-2xl font-extrabold text-neutral-900 dark:text-white">
            Dine-In Menu
          </h1>

          <div className="mt-4 rounded-2xl bg-neutral-50 p-4 dark:bg-neutral-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Your table
            </p>
            <p className="mt-0.5 text-lg font-extrabold text-neutral-900 dark:text-white">
              {context.table.label}
            </p>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              {context.restaurant.name}
            </p>
          </div>

          {/* UI5-B: menu-level service request entry (header/shell area only —
              never on food item cards). */}
          <div className="mt-3">
            <DineInServiceRequestPanel sessionId={context.sessionId} />
          </div>

          {/* UI6-B: menu-level bill entry + authoritative bill card — a
              separate header/shell entry from the service-request panel above.
              The bill card and the ordering freeze are both driven by the
              shell's authoritative bill snapshot. */}
          <div className="mt-2">
            <DineInBillRequestPanel
              sessionId={context.sessionId}
              bill={bill}
              onBillReceived={handleBillReceived}
            />
          </div>

          <div className="mt-5">
            <DineInMenuList
              restaurantId={context.restaurant.id}
              sessionId={context.sessionId}
              frozen={bill !== null}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
