import type { DineInAdvanceTarget, DineInOrderStatus } from "./api";

export const DINE_IN_ACTIVE_STATUSES: DineInOrderStatus[] = [
  "PLACED",
  "PREPARING",
  "READY_TO_SERVE",
];

interface StatusMeta {
  label: string;
  badge: string;
  dot: string;
}

export function dineInStatusMeta(status: DineInOrderStatus): StatusMeta {
  switch (status) {
    case "PLACED":
      return {
        label: "Placed",
        badge: "bg-teal-50 text-teal-700 ring-teal-200",
        dot: "bg-teal-500",
      };
    case "PREPARING":
      return {
        label: "Preparing",
        badge: "bg-blue-50 text-blue-700 ring-blue-200",
        dot: "bg-blue-500",
      };
    case "READY_TO_SERVE":
      return {
        label: "Ready to Serve",
        badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        dot: "bg-emerald-500",
      };
    case "SERVED":
      return {
        label: "Served",
        badge: "bg-slate-100 text-slate-600 ring-slate-200",
        dot: "bg-slate-400",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        badge: "bg-red-50 text-red-700 ring-red-200",
        dot: "bg-red-500",
      };
  }
}

export function nextDineInTarget(status: DineInOrderStatus): DineInAdvanceTarget | null {
  switch (status) {
    case "PLACED":
      return "PREPARING";
    case "PREPARING":
      return "READY_TO_SERVE";
    case "READY_TO_SERVE":
      return "SERVED";
    case "SERVED":
    case "CANCELLED":
      return null;
  }
}

export function dineInActionLabel(status: DineInOrderStatus): string | null {
  switch (status) {
    case "PLACED":
      return "Start Preparing";
    case "PREPARING":
      return "Mark Ready to Serve";
    case "READY_TO_SERVE":
      return "Mark Served";
    case "SERVED":
    case "CANCELLED":
      return null;
  }
}

export function isDineInCancellable(status: DineInOrderStatus): boolean {
  return status === "PLACED" || status === "PREPARING";
}

export function dineInMutationMessage(
  code: string | undefined,
  fallback?: string,
): string {
  switch (code) {
    case "INVALID_DINE_IN_TRANSITION":
      return "This order was already updated elsewhere. Refresh the board and try again.";
    case "ORDER_NOT_FOUND":
      return "This dine-in order no longer exists. It may have been removed.";
    default:
      return fallback ?? "Could not update the dine-in order. Please try again.";
  }
}
