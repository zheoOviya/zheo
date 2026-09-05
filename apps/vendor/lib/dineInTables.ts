import type { DineInTableSessionStatus, VendorTableBoardRow } from "./api";
import { shortOrderId } from "./format";

// ============================================
// Dine-in table board helpers (DINE-OPS3).
// Pure, unit-testable derivations for the
// read-only occupancy board. Nothing here
// mutates, sorts, or reaches the network.
// ============================================

interface StatusMeta {
  label: string;
  badge: string;
  dot: string;
}

// "Free" is not a session status; the board renders it whenever a table carries
// no live session. It sits beside the session map so the two chips never
// diverge in styling or copy.
export const FREE_TABLE_STATUS_META: StatusMeta = {
  label: "Free",
  badge: "bg-slate-100 text-slate-600 ring-slate-200",
  dot: "bg-slate-300",
};

export const DISABLED_TABLE_META: { label: string; badge: string } = {
  label: "Disabled",
  badge: "bg-slate-100 text-slate-500 ring-slate-300",
};

// Occupancy status chips. Frozen C1 palette: Open→sky, Active→teal,
// Bill requested→amber, Payment pending→violet. The server only ever emits a
// live session (OPEN..PAYMENT_PENDING), and this mapping is total over the
// type, so no defensive entry is needed.
export function tableSessionStatusMeta(status: DineInTableSessionStatus): StatusMeta {
  switch (status) {
    case "OPEN":
      return {
        label: "Open",
        badge: "bg-sky-50 text-sky-700 ring-sky-200",
        dot: "bg-sky-500",
      };
    case "ACTIVE":
      return {
        label: "Active",
        badge: "bg-teal-50 text-teal-700 ring-teal-200",
        dot: "bg-teal-500",
      };
    case "BILL_REQUESTED":
      return {
        label: "Bill requested",
        badge: "bg-amber-50 text-amber-700 ring-amber-200",
        dot: "bg-amber-500",
      };
    case "PAYMENT_PENDING":
      return {
        label: "Payment pending",
        badge: "bg-violet-50 text-violet-700 ring-violet-200",
        dot: "bg-violet-500",
      };
  }
}

/** A table is Free exactly when it carries no live session. */
export function isTableFree(row: Pick<VendorTableBoardRow, "session">): boolean {
  return row.session === null;
}

export interface BoardSummary {
  total: number;
  occupied: number;
  free: number;
  openRequests: number;
}

// Occupancy comes only from the live-session invariant: occupied = has a live
// session, free = no live session, regardless of is_active (a disabled table
// still reports its truth, so total always equals occupied + free). Open
// requests sum open_request_count (server already excludes BRING_BILL).
export function deriveBoardSummary(rows: VendorTableBoardRow[]): BoardSummary {
  let occupied = 0;
  let openRequests = 0;
  for (const row of rows) {
    if (row.session !== null) occupied += 1;
    openRequests += row.open_request_count;
  }
  return { total: rows.length, occupied, free: rows.length - occupied, openRequests };
}

/**
 * Short, guest-verifiable session suffix shown on occupied cards. Delegates to
 * the canonical last-four formatter so the two displays can never drift.
 */
export function shortSessionId(sessionId: string): string {
  return shortOrderId(sessionId);
}
