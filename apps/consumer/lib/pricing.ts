// ============================================
// Shared pricing math + Indian rupee formatting.
// GST: 5% food, 18% packaging. Packaging fee Rs 10/item.
// Centralizes the breakdown so CartDrawer and Checkout
// never drift apart.
// ============================================

export interface PricingItem {
  basePrice: number;
  quantity: number;
  customizations: Array<{ price_delta: number }>;
}

export interface PriceBreakdown {
  itemCount: number;
  foodSubtotal: number;
  gstFood: number;
  packagingFee: number;
  gstPackaging: number;
  total: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function itemUnitPrice(item: PricingItem): number {
  const customTotal = item.customizations.reduce(
    (sum, c) => sum + (Number.isFinite(c.price_delta) ? c.price_delta : 0),
    0,
  );
  return round2(item.basePrice + customTotal);
}

export function computePriceBreakdown(items: PricingItem[]): PriceBreakdown {
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
  const foodSubtotal = round2(
    items.reduce((sum, i) => sum + itemUnitPrice(i) * i.quantity, 0),
  );
  const gstFood = round2(foodSubtotal * 0.05);
  const packagingFee = round2(itemCount * 10);
  const gstPackaging = round2(packagingFee * 0.18);
  const total = round2(foodSubtotal + gstFood + packagingFee + gstPackaging);

  return { itemCount, foodSubtotal, gstFood, packagingFee, gstPackaging, total };
}

// Indian rupee formatting: ₹2,42.80 (en-IN digit grouping).
export function formatINR(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}
