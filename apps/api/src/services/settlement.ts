import { PRICING } from "./pricing";
import { renderSettlementPdf } from "./pdfGenerator";
import type { OrderDTO, OrderItemDTO, OrderRepository } from "../repositories/orderRepository";

// ============================================
// Settlement Engine (PRD V11 Daily Settlements)
//
// Commission is computed PER ORDER on the order's
// total_amount (which already includes GST on food +
// packaging). Taxes are recomputed deterministically
// from the persisted order_items - never trusted from
// the client.
// ============================================

export interface SettlementLine {
  order_id: string;
  order_number: string;
  total_amount: number;
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  commission_rate: number;
  commission_amount: number;
  taxes: number;
  payout: number;
}

export interface SettlementSummary {
  period_start: string;
  period_end: string;
  order_count: number;
  total_food_subtotal: number;
  total_packaging_fee: number;
  total_gst_food: number;
  total_gst_packaging: number;
  total_commission: number;
  total_taxes: number;
  net_payout: number;
  lines: SettlementLine[];
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function computeFoodSubtotal(items: OrderItemDTO[]): number {
  return round(
    items.reduce((sum, item) => sum + item.item_subtotal, 0),
  );
}

export function computePackagingFee(items: OrderItemDTO[]): number {
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  return round(itemCount * PRICING.packagingFeePerItem);
}

export function computeCommission(totalAmount: number): {
  rate: number;
  amount: number;
} {
  const rate =
    totalAmount > PRICING.commissionThreshold
      ? PRICING.commissionRateHigh
      : PRICING.commissionRateLow;
  return { rate, amount: round(totalAmount * rate) };
}

export function computeTaxes(items: OrderItemDTO[]): {
  gst_food: number;
  gst_packaging: number;
  taxes: number;
} {
  const foodSubtotal = computeFoodSubtotal(items);
  const packagingFee = computePackagingFee(items);
  const gstFood = round(foodSubtotal * PRICING.gstFood);
  const gstPackaging = round(packagingFee * PRICING.gstPackaging);
  return {
    gst_food: gstFood,
    gst_packaging: gstPackaging,
    taxes: round(gstFood + gstPackaging),
  };
}

/** Computes the settlement line for a single order. */
export function computeSettlementLine(order: OrderDTO): SettlementLine {
  const foodSubtotal = computeFoodSubtotal(order.items);
  const packagingFee = computePackagingFee(order.items);
  const { gst_food, gst_packaging, taxes } = computeTaxes(order.items);
  const { rate, amount: commissionAmount } = computeCommission(
    order.total_amount,
  );

  return {
    order_id: order.id,
    order_number: order.id.slice(0, 8).toUpperCase(),
    total_amount: round(order.total_amount),
    food_subtotal: foodSubtotal,
    packaging_fee: packagingFee,
    gst_food,
    gst_packaging,
    commission_rate: rate,
    commission_amount: commissionAmount,
    taxes,
    payout: round(order.total_amount - commissionAmount - taxes),
  };
}

/**
 * Builds a settlement summary for a set of orders.
 * `periodStart` / `periodEnd` are the UTC boundaries of the settlement day.
 */
export function buildSettlementSummary(
  orders: OrderDTO[],
  periodStart: string,
  periodEnd: string,
): SettlementSummary {
  const lines = orders.map(computeSettlementLine);

  const sum = (pick: (line: SettlementLine) => number) =>
    round(lines.reduce((acc, line) => acc + pick(line), 0));

  return {
    period_start: periodStart,
    period_end: periodEnd,
    order_count: lines.length,
    total_food_subtotal: sum((l) => l.food_subtotal),
    total_packaging_fee: sum((l) => l.packaging_fee),
    total_gst_food: sum((l) => l.gst_food),
    total_gst_packaging: sum((l) => l.gst_packaging),
    total_commission: sum((l) => l.commission_amount),
    total_taxes: sum((l) => l.taxes),
    net_payout: sum((l) => l.payout),
    lines,
  };
}

/** UTC boundaries for "yesterday" (the settled day). */
export function previousSettlementWindow(now = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

/**
 * V11 generateDailySettlement service.
 * Fetches the restaurant's PICKED_UP / SETTLED orders from the previous UTC
 * day, builds the settlement summary (0% / 8% commission + recomputed taxes),
 * and renders the PDF receipt ready to stream to the client.
 */
export async function generateDailySettlement(
  repo: Pick<OrderRepository, "getSettlableOrdersByRestaurant">,
  restaurantId: string,
  restaurantName: string,
  now = new Date(),
): Promise<{ summary: SettlementSummary; pdf: Buffer }> {
  const { periodStart, periodEnd } = previousSettlementWindow(now);
  const orders = await repo.getSettlableOrdersByRestaurant(
    restaurantId,
    periodStart,
    periodEnd,
  );
  const summary = buildSettlementSummary(orders, periodStart, periodEnd);
  const pdf = await renderSettlementPdf(restaurantName, summary);
  return { summary, pdf };
}
