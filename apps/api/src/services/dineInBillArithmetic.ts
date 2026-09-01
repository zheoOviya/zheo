// ============================================
// Pure session-level bill arithmetic (D2.5C6).
//
// Server-authoritative billing: the ONLY input is the immutable
// item_subtotal snapshots produced by the repository's
// listForBill() (which already excludes CANCELLED orders). This
// module deliberately has no knowledge of menus, orders, or the DB:
//  - it never reads DineInOrder.total_amount
//  - it never re-prices from base_price / current menu prices
//  - it never recomputes customizations
//  - it never adds commission/discount/tips/payment fees
//
// Rounding follows the accepted 2-decimal convention
// (Math.round(x * 100) / 100 — same primitive as pickup pricing.ts).
// No pickup pricing behavior is altered; this is a separate neutral
// helper scoped to the dine-in session/billing domain.
// ============================================

export const DINE_IN_GST_FOOD_RATE = 0.05;

export interface BillDraft {
  readonly food_subtotal: number;
  readonly packaging_fee: number;
  readonly gst_food: number;
  readonly gst_packaging: number;
  readonly total_amount: number;
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// Session-level arithmetic:
//  - food_subtotal: sum of ALL included item_subtotal snapshots, rounded ONCE
//    at the session level (never per-order totals summed afterwards).
//  - gst_food:      5% of the session food_subtotal, rounded once.
//  - packaging_fee / gst_packaging: frozen to 0 (no pickup packaging).
//  - total_amount:  food_subtotal + packaging_fee + gst_food + gst_packaging,
//    consistent with the accepted session_bills_arithmetic DB CHECK.
export function calculateBillDraft(
  itemSubtotals: readonly number[],
): BillDraft {
  const foodSubtotal = round2(
    itemSubtotals.reduce((sum, subtotal) => sum + subtotal, 0),
  );
  const packagingFee = 0;
  const gstFood = round2(foodSubtotal * DINE_IN_GST_FOOD_RATE);
  const gstPackaging = 0;
  const totalAmount = round2(
    foodSubtotal + packagingFee + gstFood + gstPackaging,
  );
  return {
    food_subtotal: foodSubtotal,
    packaging_fee: packagingFee,
    gst_food: gstFood,
    gst_packaging: gstPackaging,
    total_amount: totalAmount,
  };
}
