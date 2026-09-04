import type { ServiceRequestStatus, ServiceRequestType, VendorServiceRequest } from "./api";

// ============================================
// Display metadata + transition rules for the
// vendor Dine-In service-request operations
// board (DINE-OPS2).
//
// Server guarantees (do not re-derive here):
//   - queue rows are PENDING/ACKNOWLEDGED only,
//   - BRING_BILL is excluded server-side,
//   - table identity is derived server-side.
// This module stays a thin, total mapping over
// those surfaces and adds ONE defensive filter
// (isRenderableServiceRequest) so a hypothetical
// server regression can never render a BRING_BILL
// or terminal row.
// ============================================

export const SERVICE_REQUEST_ACTIVE_STATUSES: readonly ServiceRequestStatus[] = [
  "PENDING",
  "ACKNOWLEDGED",
] as const;

// The seven customer-creatable types. BRING_BILL is deliberately absent: the
// billing flow owns that artifact and it must never be rendered or acted on
// by this board.
export const RENDERABLE_SERVICE_REQUEST_TYPES: readonly Exclude<
  ServiceRequestType,
  "BRING_BILL"
>[] = ["WATER", "EXTRA_PLATE", "CUTLERY", "TISSUE", "CLEAN_TABLE", "CALL_STAFF", "OTHER"] as const;

interface StatusMeta {
  label: string;
  badge: string;
  dot: string;
}

export function serviceRequestStatusMeta(status: ServiceRequestStatus): StatusMeta {
  switch (status) {
    case "PENDING":
      return {
        label: "Pending",
        badge: "bg-amber-50 text-amber-700 ring-amber-200",
        dot: "bg-amber-500",
      };
    case "ACKNOWLEDGED":
      return {
        label: "Acknowledged",
        badge: "bg-sky-50 text-sky-700 ring-sky-200",
        dot: "bg-sky-500",
      };
    case "COMPLETED":
      return {
        label: "Completed",
        badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        dot: "bg-emerald-500",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        badge: "bg-red-50 text-red-700 ring-red-200",
        dot: "bg-red-500",
      };
  }
}

// Consumer-facing wording is shared verbatim so a guest asking for "Water"
// and a staff member reading "Water" always describe the same request.
export function serviceRequestTypeLabel(type: ServiceRequestType): string {
  switch (type) {
    case "WATER":
      return "Water";
    case "EXTRA_PLATE":
      return "Extra plate";
    case "CUTLERY":
      return "Cutlery";
    case "TISSUE":
      return "Tissue";
    case "CLEAN_TABLE":
      return "Clean table";
    case "CALL_STAFF":
      return "Call staff";
    case "BRING_BILL":
      return "Bring bill";
    case "OTHER":
      return "Other";
  }
}

export type ServiceRequestAction = "acknowledge" | "complete";

// The ONLY legal vendor action per status. PENDING is acknowledged (never
// silently completed); ACKNOWLEDGED is completed (PENDING is never skipped).
// Terminal statuses have no action — but they should never reach the board.
export function serviceRequestAction(status: ServiceRequestStatus): ServiceRequestAction | null {
  switch (status) {
    case "PENDING":
      return "acknowledge";
    case "ACKNOWLEDGED":
      return "complete";
    case "COMPLETED":
    case "CANCELLED":
      return null;
  }
}

export function serviceRequestActionLabel(action: ServiceRequestAction | null): string | null {
  switch (action) {
    case "acknowledge":
      return "Acknowledge";
    case "complete":
      return "Mark Complete";
    case null:
      return null;
  }
}

export function serviceRequestBusyLabel(action: ServiceRequestAction): string {
  switch (action) {
    case "acknowledge":
      return "Acknowledging...";
    case "complete":
      return "Completing...";
  }
}

export function isBringBillRequest(type: ServiceRequestType): boolean {
  return type === "BRING_BILL";
}

// Defensive render guard. The server already excludes BRING_BILL and terminal
// statuses; this exists so a regression can never surface an un-actionable or
// billing-flow-owned row on the board.
export function isRenderableServiceRequest(
  request: Pick<VendorServiceRequest, "request_type" | "status">,
): boolean {
  return (
    !isBringBillRequest(request.request_type) &&
    (SERVICE_REQUEST_ACTIVE_STATUSES as readonly ServiceRequestStatus[]).includes(request.status)
  );
}

export function serviceRequestMutationMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "INVALID_SERVICE_REQUEST_TRANSITION":
      return "This request was already updated elsewhere. The board will refresh.";
    case "SERVICE_REQUEST_NOT_FOUND":
      return "This service request no longer exists. The board will refresh.";
    case "BRING_BILL_MANAGED_BY_BILL_FLOW":
      return "Bringing the bill is handled by the billing flow.";
    default:
      return fallback ?? "Could not update this service request. Please try again.";
  }
}
