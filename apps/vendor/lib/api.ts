"use client";

import { RESTAURANT_ID } from "./constants";

// ============================================
// Vendor console API client.
// All /api/vendor/* endpoints are role-gated
// (VENDOR_OWNER / VENDOR_STAFF), so every request
// carries the demo-owner Bearer token obtained via
// the dev OTP login. Previously pages used plain
// fetch -> 401 -> silently empty dashboards.
// ============================================

const DEMO_PHONE = "+919876000001"; // seeded VENDOR_OWNER (SnakZap Mumbai Chain)
const DEVICE_FP = "vendor-demo-fp-0001";
const DEMO_OTP = "111111";

let cachedToken: string | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  await fetch("/api/v1/auth/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: DEMO_PHONE }),
  });

  const res = await fetch("/api/v1/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: DEMO_PHONE,
      otp: DEMO_OTP,
      device_fingerprint: DEVICE_FP,
    }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(body.error?.message ?? "Demo login failed");
  }
  cachedToken = body.data.access_token as string;
  return cachedToken;
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  const body = (await res.json()) as { data: T; error: null };
  return body.data;
}

// ============================================
// Types
// ============================================

export type OrderStatus =
  | "DRAFT"
  | "PAYMENT_PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "ALMOST_READY"
  | "READY_FOR_PICKUP"
  | "PICKED_UP"
  | "CANCELLED"
  | "REFUNDED"
  | "PAYMENT_FAILED"
  | "EXPIRED"
  | "DISPUTED"
  | "SETTLED";

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet" | "cod" | null;

export interface VendorOrder {
  id: string;
  status: OrderStatus;
  total_amount: number;
  restaurant_name: string | null;
  scheduled_pickup_time: string | null;
  items: {
    name: string;
    quantity: number;
    base_price: number;
    customizations: { name: string; price_delta: number }[];
  }[];
  pickup_otp: string | null;
  qr_token: string | null;
  checked_in: boolean;
  created_at: string;
  payment_method: PaymentMethod;
  payment_status: string | null;
  customer_phone: string | null;
  is_catering: boolean;
  headcount: number | null;
}

export interface VendorMenuItem {
  id: string;
  name: string;
  price: number;
  description: string | null;
  dietary_tags: Record<string, boolean>;
  image_url: string | null;
  is_available: boolean;
}

export interface Promotion {
  id: string;
  title: string;
  discount_type: "FLAT" | "PERCENTAGE";
  value: number;
  valid_until: string;
  is_active: boolean;
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
  lines: {
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
  }[];
}

export interface Insights {
  days: number;
  window_start: string;
  window_end: string;
  order_count: number;
  total_revenue: number;
  aov: number;
  repeat_rate: number;
  repeat_customers: number;
  total_customers: number;
  peak_hours: { hour: number; label: string; order_count: number }[];
}

export interface Chain {
  id: string;
  name: string;
  outlets: { restaurant_id: string; name: string }[];
}

export interface ChainAggregateInsights {
  chain_id: string;
  chain_name: string;
  outlet_count: number;
  total_orders: number;
  total_revenue: number;
  combined_aov: number;
  outlets: {
    restaurant_id: string;
    name: string;
    order_count: number;
    revenue: number;
    aov: number;
    share: number;
  }[];
}

export interface Restaurant {
  id: string;
  name: string;
  gst_number?: string | null;
}

export interface PosSyncResult {
  synced: boolean;
}

export interface PosSimulateResult {
  menu_synced: boolean;
  import: {
    order_id: string;
    order_status: string;
    processed: boolean;
    idempotent: boolean;
  };
}

// ============================================
// Orders
// ============================================

export async function fetchOrders(
  options: { scope?: "active" | "all"; status?: OrderStatus } = {},
  restaurantId: string = RESTAURANT_ID,
): Promise<VendorOrder[]> {
  const params = new URLSearchParams({ restaurant_id: restaurantId });
  params.set("scope", options.scope ?? "active");
  if (options.status) params.set("status", options.status);
  return read<VendorOrder[]>(await authedFetch(`/api/vendor/orders?${params.toString()}`));
}

export interface AdvanceOrderResult {
  order_id: string;
  status: OrderStatus;
  pickup_otp: string | null;
  qr_token: string | null;
  early_ready_alerted: boolean;
}

export async function advanceOrder(orderId: string): Promise<AdvanceOrderResult> {
  return read<AdvanceOrderResult>(
    await authedFetch(`/api/vendor/orders/${orderId}/status`, { method: "PUT" }),
  );
}

export async function confirmPickup(
  orderId: string,
  pickupOtp: string,
): Promise<{ status: OrderStatus; picked_up: boolean }> {
  return read(
    await authedFetch(`/api/v1/orders/${orderId}/confirm-pickup`, {
      method: "POST",
      body: JSON.stringify({ pickup_otp: pickupOtp }),
    }),
  );
}

export async function cancelOrder(
  orderId: string,
): Promise<{ order_id: string; status: OrderStatus }> {
  return read(await authedFetch(`/api/vendor/orders/${orderId}/cancel`, { method: "PUT" }));
}

// ============================================
// Menu
// ============================================

export async function fetchMenu(restaurantId: string = RESTAURANT_ID): Promise<VendorMenuItem[]> {
  return read<VendorMenuItem[]>(
    await authedFetch(`/api/vendor/menu?restaurant_id=${restaurantId}`),
  );
}

export async function updateMenuItem(
  itemId: string,
  patch: { price?: number; is_available?: boolean; description?: string | null },
  restaurantId: string = RESTAURANT_ID,
): Promise<VendorMenuItem> {
  return read<VendorMenuItem>(
    await authedFetch(`/api/vendor/menu/${itemId}?restaurant_id=${restaurantId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  );
}

export async function bulkUpdateMenu(
  items: { item_id: string; price?: number; is_available?: boolean; description?: string | null }[],
  restaurantId: string = RESTAURANT_ID,
): Promise<VendorMenuItem[]> {
  return read<VendorMenuItem[]>(
    await authedFetch(`/api/vendor/menu/bulk?restaurant_id=${restaurantId}`, {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  );
}

export async function uploadMenuPhoto(
  itemId: string,
  photo: File,
  restaurantId: string = RESTAURANT_ID,
): Promise<{ id: string; image_url: string }> {
  const token = await getAccessToken();
  const form = new FormData();
  form.append("photo", photo);
  const res = await fetch(`/api/vendor/menu/${itemId}/upload-photo?restaurant_id=${restaurantId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return read(res);
}

// ============================================
// Money: settlements, insights, GST, promotions
// ============================================

export async function fetchSettlementSummary(
  restaurantId: string = RESTAURANT_ID,
): Promise<SettlementSummary> {
  return read<SettlementSummary>(
    await authedFetch(`/api/vendor/settlements/summary?restaurant_id=${restaurantId}`),
  );
}

export async function downloadSettlementPdf(restaurantId: string = RESTAURANT_ID): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`/api/vendor/settlements/today?restaurant_id=${restaurantId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `settlement-${new Date().toISOString().slice(0, 10)}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function fetchInsights(
  days: number,
  restaurantId: string = RESTAURANT_ID,
): Promise<Insights> {
  return read<Insights>(
    await authedFetch(`/api/vendor/insights?restaurant_id=${restaurantId}&days=${days}`),
  );
}

export async function fetchPromotions(): Promise<Promotion[]> {
  return read<Promotion[]>(await authedFetch("/api/vendor/promotions"));
}

export async function createPromotion(input: {
  title: string;
  discount_type: "FLAT" | "PERCENTAGE";
  value: number;
  valid_until: string;
}): Promise<Promotion> {
  return read<Promotion>(
    await authedFetch("/api/vendor/promotions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function downloadGstCsv(
  month: string,
  restaurantId: string = RESTAURANT_ID,
): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`/api/vendor/gst-export?restaurant_id=${restaurantId}&month=${month}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gstr1-${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================
// Chains + catering
// ============================================

export async function fetchChains(): Promise<Chain[]> {
  return read<Chain[]>(await authedFetch("/api/vendor/chains"));
}

export async function fetchChainAggregate(chainId: string): Promise<ChainAggregateInsights> {
  return read<ChainAggregateInsights>(
    await authedFetch(`/api/vendor/chains/${chainId}/aggregate-insights`),
  );
}

export interface CateringOrderResult {
  id: string;
  status: string;
  is_catering: boolean;
  headcount: number;
  total_amount: number;
  items: { name: string; quantity: number; base_price: number; item_subtotal: number }[];
  event_date: string;
  budget: number | null;
  special_instructions: string | null;
}

export async function placeCateringOrder(input: {
  restaurant_id: string;
  event_date: string;
  headcount: number;
  budget?: number;
  special_instructions?: string;
  items: { menu_item_id: string; quantity: number; unit_price?: number; description?: string }[];
}): Promise<CateringOrderResult> {
  return read<CateringOrderResult>(
    await authedFetch("/api/v1/orders/catering", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

// ============================================
// POS
// ============================================

export async function syncPosMenu(restaurantId: string = RESTAURANT_ID): Promise<PosSyncResult> {
  return read<PosSyncResult>(
    await authedFetch(`/api/vendor/pos/sync-menu?restaurant_id=${restaurantId}`, {
      method: "POST",
    }),
  );
}

export async function simulatePosOrder(
  restaurantId: string = RESTAURANT_ID,
): Promise<PosSimulateResult> {
  return read<PosSimulateResult>(
    await authedFetch(`/api/vendor/pos/simulate-order?restaurant_id=${restaurantId}`, {
      method: "POST",
    }),
  );
}

// ============================================
// Catalog
// ============================================

export async function fetchRestaurants(): Promise<Restaurant[]> {
  const res = await fetch("/api/v1/restaurants");
  return read<Restaurant[]>(res);
}

export async function fetchRestaurant(
  restaurantId: string = RESTAURANT_ID,
): Promise<Restaurant | null> {
  const restaurants = await fetchRestaurants();
  return restaurants.find((r) => r.id === restaurantId) ?? null;
}
