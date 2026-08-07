import { AppError } from "../middleware/envelope";
import type { OrderDTO } from "../repositories/orderRepository";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import { computeFoodSubtotal } from "./settlement";

// ============================================
// GST Compliance Export (PRD Phase 2, V12)
// Generates a GSTR-1 ready CSV for a calendar month.
//
//   - Month window is [start, end) over UTC boundaries.
//   - Only PICKED_UP / SETTLED orders are eligible (caller fetches via
//     getSettlableOrdersByRestaurant) - unpaid and cancelled orders never
//     appear on a tax return.
//   - Taxable Value is the GST-exclusive food subtotal recomputed from the
//     persisted order items. CGST 2.5% + SGST 2.5% = the 5% food GST rate.
//   - Values are always recomputed server-side, never trusted from input.
// ============================================

const GST_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

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

/** Deterministic GSTIN: restaurant's own number, else a mock derived from id. */
export function gstinForRestaurant(restaurant: {
  id: string;
  gst_number: string | null;
}): string {
  if (restaurant.gst_number && restaurant.gst_number.length > 0) {
    return restaurant.gst_number;
  }
  const digits = restaurant.id.replace(/[^0-9]/g, "").padEnd(10, "0");
  return `27MOCK${digits.slice(0, 10)}Z${digits.slice(0, 1)}5`;
}

export function invoiceNumber(index: number, month: string): string {
  return `INV-${month}-${String(index + 1).padStart(4, "0")}`;
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
  invoice_no: string;
  gstin: string;
  date: string;
  taxable_value: number;
  cgst: number;
  sgst: number;
}

export function gstRowForOrder(
  order: OrderDTO,
  index: number,
  month: string,
  gstin: string,
): GstCsvRow {
  const taxable = round2(computeFoodSubtotal(order.items));
  const cgst = round2(taxable * 0.025);
  const sgst = round2(taxable * 0.025);
  return {
    invoice_no: invoiceNumber(index, month),
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
  month: string,
): string {
  const gstin = gstinForRestaurant(restaurant);
  const header = "Invoice No,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%";
  const rows = orders.map((order, index) => {
    const row = gstRowForOrder(order, index, month, gstin);
    return [
      csvEscape(row.invoice_no),
      csvEscape(row.gstin),
      csvEscape(row.date),
      csvEscape(row.taxable_value.toFixed(2)),
      csvEscape(row.cgst.toFixed(2)),
      csvEscape(row.sgst.toFixed(2)),
    ].join(",");
  });
  return [header, ...rows].join("\r\n");
}
