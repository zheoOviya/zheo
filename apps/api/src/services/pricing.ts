// ============================================
// Pricing Logic (PRD Section 1, O10 Price Breakdown)
// Item total = base price + customization deltas
// GST: 5% food, 18% packaging
// Commission: 0% if total <= 200, 8% if > 200
// ============================================

export interface CustomizationDelta {
  name: string;
  price_delta: number;
}

export interface OrderItemInput {
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: CustomizationDelta[];
}

export interface ItemBreakdown {
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: CustomizationDelta[];
  customization_total: number;
  item_subtotal: number; // (base + customizations) * quantity
}

export interface PriceBreakdown {
  items: ItemBreakdown[];
  food_subtotal: number;
  packaging_fee: number;
  packaging_fee_per_item: number;
  gst_food: number; // 5% on food subtotal
  gst_packaging: number; // 18% on packaging
  total_amount: number;
  commission_rate: number; // 0.00 or 0.08
  commission_amount: number; // for settlement (not shown to consumer)
}

export const PRICING = {
  gstFood: 0.05,
  gstPackaging: 0.18,
  packagingFeePerItem: 10,
  commissionThreshold: 200,
  commissionRateHigh: 0.08,
  commissionRateLow: 0.0,
} as const;

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function calculateItemBreakdown(item: OrderItemInput): ItemBreakdown {
  const customizationTotal = item.customizations.reduce(
    (sum, c) => sum + c.price_delta,
    0,
  );
  const unitPrice = item.base_price + customizationTotal;
  const itemSubtotal = unitPrice * item.quantity;

  return {
    menu_item_id: item.menu_item_id,
    name: item.name,
    base_price: item.base_price,
    quantity: item.quantity,
    customizations: item.customizations,
    customization_total: round(customizationTotal),
    item_subtotal: round(itemSubtotal),
  };
}

export function calculatePriceBreakdown(items: OrderItemInput[]): PriceBreakdown {
  const breakdowns = items.map(calculateItemBreakdown);

  const foodSubtotal = breakdowns.reduce((sum, b) => sum + b.item_subtotal, 0);
  const totalItems = breakdowns.reduce((sum, b) => sum + b.quantity, 0);
  const packagingFee = round(totalItems * PRICING.packagingFeePerItem);

  const gstFood = round(foodSubtotal * PRICING.gstFood);
  const gstPackaging = round(packagingFee * PRICING.gstPackaging);

  const totalAmount = round(foodSubtotal + packagingFee + gstFood + gstPackaging);

  const commissionRate =
    totalAmount > PRICING.commissionThreshold
      ? PRICING.commissionRateHigh
      : PRICING.commissionRateLow;
  const commissionAmount = round(totalAmount * commissionRate);

  return {
    items: breakdowns,
    food_subtotal: round(foodSubtotal),
    packaging_fee: packagingFee,
    packaging_fee_per_item: PRICING.packagingFeePerItem,
    gst_food: gstFood,
    gst_packaging: gstPackaging,
    total_amount: totalAmount,
    commission_rate: commissionRate,
    commission_amount: commissionAmount,
  };
}
