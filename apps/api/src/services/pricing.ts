// ============================================
// Pricing Logic (PRD Section 1, O10 Price Breakdown)
// Item total = base price + customization deltas
// GST: 5% food, 18% packaging
// Commission: 0% if total <= 200, 8% if > 200
//
// Security invariant (Task 2): customization prices are ALWAYS resolved
// from the server catalog by name. The client-supplied `price_delta` is
// never trusted as a monetary input.
// ============================================

import { AppError } from "../middleware/envelope";

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
  gift_id?: string | null;
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

// ============================================
// Server-authoritative customization resolution (Task 2)
//
// Resolves every requested customization to the price stored on the menu
// item's own catalog `customizations` array. The client's `price_delta` is
// ignored entirely - only the name travels from the request, and the money
// comes from the catalog. Fail-closed on malformed or ambiguous catalog
// data so an unvalidated entry can never become a trusted price.
// ============================================

export function resolveCatalogCustomizations(
  menuCustomizations: unknown[],
  requested: CustomizationDelta[],
): CustomizationDelta[] {
  const catalogMap = new Map<string, number>();
  for (const raw of menuCustomizations) {
    if (typeof raw !== "object" || raw === null) {
      throw new AppError(
        "INVALID_CATALOG_CUSTOMIZATION",
        "Catalog customization entry is malformed",
        500,
      );
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      throw new AppError(
        "INVALID_CATALOG_CUSTOMIZATION",
        "Catalog customization entry is missing a valid name",
        500,
      );
    }
    if (typeof entry.price_delta !== "number" || !Number.isFinite(entry.price_delta)) {
      throw new AppError(
        "INVALID_CATALOG_CUSTOMIZATION",
        `Catalog customization "${entry.name}" has a non-finite price`,
        500,
      );
    }
    if (entry.price_delta < 0) {
      throw new AppError(
        "INVALID_CATALOG_CUSTOMIZATION",
        `Catalog customization "${entry.name}" has a negative price delta`,
        500,
      );
    }
    if (catalogMap.has(entry.name)) {
      throw new AppError(
        "INVALID_CATALOG_CUSTOMIZATION",
        `Catalog customization "${entry.name}" is defined more than once`,
        500,
      );
    }
    catalogMap.set(entry.name, entry.price_delta);
  }

  const requestedNames = new Set<string>();
  const resolved: CustomizationDelta[] = [];
  for (const req of requested) {
    if (typeof req.name !== "string" || req.name.length === 0) {
      throw new AppError(
        "INVALID_CUSTOMIZATION",
        "Customization name must be a non-empty string",
        400,
      );
    }
    if (requestedNames.has(req.name)) {
      throw new AppError(
        "INVALID_CUSTOMIZATION",
        `Customization "${req.name}" is requested more than once`,
        400,
      );
    }
    requestedNames.add(req.name);
    const price = catalogMap.get(req.name);
    if (price === undefined) {
      throw new AppError(
        "INVALID_CUSTOMIZATION",
        `Customization "${req.name}" is not offered for this item`,
        400,
      );
    }
    resolved.push({ name: req.name, price_delta: price });
  }
  return resolved;
}

/** Defense-in-depth: an order whose server-computed total is not positive is rejected. */
export function assertPositiveTotalAmount(breakdown: PriceBreakdown): void {
  if (breakdown.total_amount <= 0) {
    throw new AppError(
      "INVALID_ORDER_AMOUNT",
      "Order total must be positive",
      400,
    );
  }
}
