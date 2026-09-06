import type { VendorBillDetail } from "./api";
import { serviceRequestStatusMeta } from "./serviceRequests";

// ============================================
// Vendor Dine-In bill helpers (DINE-OPS4-C2).
//
// Pure, unit-testable derivations for the
// actionable bill queue (/dine-in/bills) and the
// read-only bill detail (/dine-in/bills/[billId]).
// Nothing here mutates, sorts, or reaches the
// network.
//
// Server guarantees (do not re-derive here):
//   - the queue is BILL_REQUESTED sessions whose
//     BRING_BILL artifact is PENDING or
//     ACKNOWLEDGED, ordered bill_requested_at ASC
//     then bill.id ASC,
//   - COMPLETED leaves the queue; the bill detail
//     stays readable,
//   - the bill monetary snapshot is frozen; only
//     the BRING_BILL lifecycle fields move until
//     COMPLETED.
// This module is a thin, total mapping over those
// surfaces.
// ============================================

export type VendorBillQueueStatus = "PENDING" | "ACKNOWLEDGED";

export type VendorBillAction = "acknowledge" | "deliver";

interface StatusMeta {
  label: string;
  badge: string;
  dot: string;
}

// Queue rows only ever carry PENDING / ACKNOWLEDGED. Labels and colors are
// shared with the dine-in service-request board so a "Pending" bill and a
// "Pending" service request read identically to staff.
export function billQueueStatusMeta(status: VendorBillQueueStatus): StatusMeta {
  return serviceRequestStatusMeta(status);
}

// The bill detail can additionally reach COMPLETED. PENDING/ACKNOWLEDGED share
// the board vocabulary; COMPLETED is deliberately worded "Delivered" because a
// bill that left the queue is a delivered bill, not a generic completed task.
export function billDetailStatusMeta(
  status: "PENDING" | "ACKNOWLEDGED" | "COMPLETED",
): StatusMeta {
  switch (status) {
    case "COMPLETED":
      return {
        label: "Delivered",
        badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        dot: "bg-emerald-500",
      };
    case "PENDING":
    case "ACKNOWLEDGED":
      return serviceRequestStatusMeta(status);
  }
}

// The ONLY legal vendor action per queue status. PENDING is acknowledged
// (never silently delivered); ACKNOWLEDGED is delivered (PENDING is never
// skipped). No cancel exists on the bill surface.
export function billAction(status: VendorBillQueueStatus): VendorBillAction {
  switch (status) {
    case "PENDING":
      return "acknowledge";
    case "ACKNOWLEDGED":
      return "deliver";
  }
}

export function billActionLabel(action: VendorBillAction | null): string | null {
  switch (action) {
    case "acknowledge":
      return "Acknowledge";
    case "deliver":
      return "Mark delivered";
    case null:
      return null;
  }
}

export function billBusyLabel(action: VendorBillAction): string {
  switch (action) {
    case "acknowledge":
      return "Acknowledging...";
    case "deliver":
      return "Delivering...";
  }
}

export function billMutationMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "INVALID_SERVICE_REQUEST_TRANSITION":
      return "This bill was already handled elsewhere. The queue will refresh.";
    case "BILL_NOT_FOUND":
      return "This bill is no longer available. The queue will refresh.";
    default:
      return fallback ?? "Could not update this bill. Please try again.";
  }
}

// A bill is delivered exactly when its BRING_BILL artifact reached COMPLETED.
export function isDeliveredBill(detail: VendorBillDetail): boolean {
  return detail.bring_bill_request?.status === "COMPLETED";
}

// Presentation-only GST line: sums the two already-frozen GST fields. It never
// derives or recomputes the authoritative bill total.
export function billGstTotal(bill: { gst_food: number; gst_packaging: number }): number {
  return bill.gst_food + bill.gst_packaging;
}

// Packaging is charged only when the frozen snapshot recorded a positive fee;
// a zero/absent packaging fee must not render a packaging line.
export function hasPackagingFee(bill: { packaging_fee: number }): boolean {
  return bill.packaging_fee > 0;
}
