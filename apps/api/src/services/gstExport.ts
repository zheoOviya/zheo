import { AppError } from "../middleware/envelope";
import type { OrderDTO } from "../repositories/orderRepository";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import { computeFoodSubtotal } from "./settlement";

// ============================================
// GST Export (PRD Phase 2, V12)
// Generates a CSV of eligible order tax data for a calendar month.
//
//   - Month window is [start, end) over UTC boundaries.
//   - Only PICKED_UP / SETTLED orders are eligible (caller fetches via
//     getSettlableOrdersByRestaurant) - unpaid and cancelled orders never
//     appear.
//   - Taxable Value is the GST-exclusive food subtotal recomputed from the
//     persisted order items. CGST 2.5% + SGST 2.5% = the 5% food GST rate.
//   - Values are always recomputed server-side, never trusted from input.
//
// GST_EXPORT_TRUTH_A2 (statutory identity + copy):
//   - The restaurant's real persisted GSTIN is emitted exactly. A missing /
//     blank / whitespace GSTIN FAILS CLOSED (GST_NUMBER_REQUIRED); a synthetic
//     GSTIN is never fabricated.
//   - "Order Reference" is the persisted order id: a stable but explicitly
//     NON-STATUTORY reference. No array-position invoice number is generated
//     and no statutory "invoice number" is claimed. This CSV is a tax-data
//     export, not a filing-ready statutory return.
// ============================================

const GST_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** CSV header. "Order Reference" is a non-statutory identifier, never an invoice number. */
export const GST_CSV_HEADER =
  "Order Reference,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%";

export function parseGstMonth(value: unknown): string {
  if (typeof value !== "string" || !GST_MONTH_PATTERN.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "month must be in YYYY-MM format",
      400,
    );
  }
  return value;
}

export interface GstMonthWindow {
  startIso: string;
  endIso: string;
}

export function gstMonthWindow(month: string): GstMonthWindow {
  const [yearStr, monthStr] = month.split("-");
  const year = Number.parseInt(yearStr!, 10);
  const monthIndex = Number.parseInt(monthStr!, 10) - 1;
  const start = Date.UTC(year, monthIndex, 1);
  const end = Date.UTC(year, monthIndex + 1, 1);
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
  };
}

/**
 * The restaurant's real persisted GSTIN, emitted exactly.
 * Missing / blank / whitespace-only GSTIN fails closed so the export can never
 * carry a fabricated or empty statutory identity.
 */
export function gstinForRestaurant(restaurant: {
  id: string;
  gst_number: string | null;
}): string {
  const stored = restaurant.gst_number;
  if (typeof stored === "string" && stored.trim().length > 0) {
    return stored;
  }
  throw new AppError(
    "GST_NUMBER_REQUIRED",
    "Restaurant GSTIN is not configured; GST export is unavailable",
    422,
  );
}

/** RFC 4180 escaping: quote fields containing , " or newline; double quotes. */
export function csvEscape(value: string | number): string {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface GstCsvRow {
  order_reference: string;
  gstin: string;
  date: string;
  taxable_value: number;
  cgst: number;
  sgst: number;
}

/**
 * One CSV row per order. `order_reference` is the persisted order id: stable
 * across re-exports and windows, and explicitly non-statutory (never labelled
 * as an invoice number).
 */
export function gstRowForOrder(order: OrderDTO, gstin: string): GstCsvRow {
  const taxable = round2(computeFoodSubtotal(order.items));
  const cgst = round2(taxable * 0.025);
  const sgst = round2(taxable * 0.025);
  return {
    order_reference: order.id,
    gstin,
    date: order.created_at.slice(0, 10),
    taxable_value: taxable,
    cgst,
    sgst,
  };
}

export function buildGstCsv(
  orders: OrderDTO[],
  restaurant: RestaurantDTO,
): string {
  const gstin = gstinForRestaurant(restaurant);
  const rows = orders.map((order) => {
    const row = gstRowForOrder(order, gstin);
    return [
      csvEscape(row.order_reference),
      csvEscape(row.gstin),
      csvEscape(row.date),
      csvEscape(row.taxable_value.toFixed(2)),
      csvEscape(row.cgst.toFixed(2)),
      csvEscape(row.sgst.toFixed(2)),
    ].join(",");
  });
  return [GST_CSV_HEADER, ...rows].join("\r\n");
}
