import { DINE_IN_GST_FOOD_RATE } from "./dineInBillArithmetic";
import type { ValidatedPlaceOrderLine } from "./dineInOrder";

// ============================================
// Pure order-level pricing (D2.5D3).
//
// Server-authoritative: the ONLY input is the validated authoritative
// catalog facts produced by D2 (menu_item_id / quantity / item_name /
// base_price from the catalog reader). Caller prices do not exist in
// the input type and are never read here.
//
// dine_in_orders.total_amount is an ORDER-LEVEL DISPLAY/SNAPSHOT amount
// only. The future SessionBill MUST NOT sum order.total_amount values:
// session-bill authority stays with the immutable
// dine_in_order_items.item_subtotal snapshots -> session-level subtotal
// -> session-level GST (C6/C7 rule, unchanged here). This module never
// reads/persists a SessionBill and never calls pickup pricing.
//
// Rounding follows the accepted 2-decimal convention
// (Math.round(x * 100) / 100 — same primitive as C6/pickup pricing.ts).
// No packaging, commission, discount, tips, payment fee, customization
// or promotional pricing. A valid zero-price item is NOT rejected:
// pricing validity is distinct from billable-order existence rules.
// ============================================

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface PricedOrderLine {
  readonly menu_item_id: string;
  readonly name: string;
  readonly base_price: number;
  readonly quantity: number;
  readonly item_subtotal: number;
}

export interface OrderPricingDraft {
  readonly lines: readonly PricedOrderLine[];
  readonly food_subtotal: number;
  readonly gst_food: number;
  readonly total_amount: number;
}

// Per-line item_subtotal = round2(base_price * quantity). Duplicate
// lines are preserved independently (never merged). Order food subtotal
// = round2(sum of all item_subtotal), rounded once at the aggregate
// order level. gst_food = round2(food_subtotal * 5%). total_amount =
// round2(food_subtotal + gst_food).
export function calculateOrderPricing(
  lines: readonly ValidatedPlaceOrderLine[],
): OrderPricingDraft {
  const pricedLines: PricedOrderLine[] = lines.map((line) => ({
    menu_item_id: line.menu_item_id,
    name: line.item_name,
    base_price: line.base_price,
    quantity: line.quantity,
    item_subtotal: round2(line.base_price * line.quantity),
  }));
  const foodSubtotal = round2(
    pricedLines.reduce((sum, line) => sum + line.item_subtotal, 0),
  );
  const gstFood = round2(foodSubtotal * DINE_IN_GST_FOOD_RATE);
  const totalAmount = round2(foodSubtotal + gstFood);
  return {
    lines: pricedLines,
    food_subtotal: foodSubtotal,
    gst_food: gstFood,
    total_amount: totalAmount,
  };
}
