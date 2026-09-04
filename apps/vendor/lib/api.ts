"use client";

import {
  refreshSession,
  logout as clearVendorSession,
} from "./auth";

// ============================================
// Vendor console API client.
// All /api/vendor/* endpoints are role-gated
// (VENDOR_OWNER / VENDOR_STAFF), but auth is now
// carried by the httpOnly access cookie
// (snakzap_access), so no token is stored or sent
// from JavaScript. If no session is present the
// caller is bounced to /login; on a 401 the access
// cookie is silently refreshed once before giving up.
// ============================================

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = () =>
    fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.headers ?? {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await doFetch();
    } else {
      await clearVendorSession();
      if (typeof window !== "undefined") window.location.href = "/login";
      throw new Error("Session expired");
    }
  }
  return res;
}

async function read<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.code,
      res.status,
    );
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

export type DineInOrderStatus =
  | "PLACED"
  | "PREPARING"
  | "READY_TO_SERVE"
  | "SERVED"
  | "CANCELLED";

export type DineInAdvanceTarget = "PREPARING" | "READY_TO_SERVE" | "SERVED";

export interface VendorDineInOrder {
  id: string;
  session_id: string;
  status: DineInOrderStatus;
  total_amount: number;
  created_at: string;
  table: { id: string; label: string };
  items: {
    menu_item_id: string;
    name: string;
    quantity: number;
    item_subtotal: number;
  }[];
}

export type ServiceRequestType =
  | "WATER"
  | "EXTRA_PLATE"
  | "CUTLERY"
  | "TISSUE"
  | "CLEAN_TABLE"
  | "CALL_STAFF"
  | "BRING_BILL"
  | "OTHER";

export type ServiceRequestStatus =
  | "PENDING"
  | "ACKNOWLEDGED"
  | "COMPLETED"
  | "CANCELLED";

// Vendor service-request operations board row. Mirrors the backend
// ServiceRequestOperationsDTO read surface exactly: actionable statuses only
// (PENDING/ACKNOWLEDGED), BRING_BILL excluded server-side, table identity
// derived server-side. No client-side order/session join is attempted.
export interface VendorServiceRequest {
  id: string;
  session_id: string;
  restaurant_id: string;
  request_type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  created_at: string;
  table: { id: string; label: string };
}

// Acknowledge/complete mutation result. The backend returns the request's
// ServiceRequestDTO under `data.request`; the board only patches status from it
// (table/note/created_at live in the queue row and stay authoritative there).
// The type mirrors the DTO fields the board reads (requested_by and other
// fields are intentionally omitted).
export interface ServiceRequestMutationResult {
  request: {
    id: string;
    session_id: string;
    restaurant_id: string;
    request_type: ServiceRequestType;
    status: ServiceRequestStatus;
    note: string | null;
    acknowledged_by: string | null;
    acknowledged_at: string | null;
    completed_by: string | null;
    completed_at: string | null;
    cancelled_by: string | null;
    cancelled_at: string | null;
    created_at: string;
    updated_at: string;
  };
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

/** A restaurant the signed-in vendor is authorized to operate. */
export interface VendorRestaurant {
  id: string;
  name: string;
  is_active: boolean;
  commission_rate: number;
  chain_id: string | null;
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
  restaurantId: string,
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
// Dine-in orders
// ============================================

export interface DineInMutationResult {
  order: { id: string; status: DineInOrderStatus };
}

export async function fetchDineInOrders(restaurantId: string): Promise<VendorDineInOrder[]> {
  const params = new URLSearchParams({ restaurant_id: restaurantId });
  return read<VendorDineInOrder[]>(
    await authedFetch(`/api/vendor/dine-in/orders?${params.toString()}`),
  );
}

export async function advanceDineInOrder(
  orderId: string,
  targetStatus: DineInAdvanceTarget,
): Promise<DineInMutationResult> {
  return read<DineInMutationResult>(
    await authedFetch(`/api/vendor/dine-in/orders/${orderId}/advance`, {
      method: "POST",
      body: JSON.stringify({ target_status: targetStatus }),
    }),
  );
}

export async function cancelDineInOrder(orderId: string): Promise<DineInMutationResult> {
  return read<DineInMutationResult>(
    await authedFetch(`/api/vendor/dine-in/orders/${orderId}/cancel`, {
      method: "POST",
    }),
  );
}

// ============================================
// Dine-In service requests
// ============================================

export async function fetchDineInServiceRequests(
  restaurantId: string,
): Promise<VendorServiceRequest[]> {
  const params = new URLSearchParams({ restaurant_id: restaurantId });
  return read<VendorServiceRequest[]>(
    await authedFetch(`/api/vendor/dine-in/service-requests?${params.toString()}`),
  );
}

export async function acknowledgeDineInServiceRequest(
  requestId: string,
): Promise<ServiceRequestMutationResult> {
  return read<ServiceRequestMutationResult>(
    await authedFetch(`/api/vendor/dine-in/service-requests/${requestId}/acknowledge`, {
      method: "POST",
    }),
  );
}

export async function completeDineInServiceRequest(
  requestId: string,
): Promise<ServiceRequestMutationResult> {
  return read<ServiceRequestMutationResult>(
    await authedFetch(`/api/vendor/dine-in/service-requests/${requestId}/complete`, {
      method: "POST",
    }),
  );
}

// ============================================
// Menu
// ============================================

export async function fetchMenu(restaurantId: string): Promise<VendorMenuItem[]> {
  return read<VendorMenuItem[]>(
    await authedFetch(`/api/vendor/menu?restaurant_id=${restaurantId}`),
  );
}

export async function updateMenuItem(
  itemId: string,
  patch: { price?: number; is_available?: boolean; description?: string | null },
  restaurantId: string,
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
  restaurantId: string,
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
  restaurantId: string,
): Promise<{ id: string; image_url: string }> {
  const form = new FormData();
  form.append("photo", photo);
  const res = await fetch(`/api/vendor/menu/${itemId}/upload-photo?restaurant_id=${restaurantId}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return read(res);
}

// ============================================
// Money: settlements, insights, GST, promotions
// ============================================

export async function fetchSettlementSummary(
  restaurantId: string,
): Promise<SettlementSummary> {
  return read<SettlementSummary>(
    await authedFetch(`/api/vendor/settlements/summary?restaurant_id=${restaurantId}`),
  );
}

export async function downloadSettlementPdf(restaurantId: string): Promise<void> {
  const res = await fetch(`/api/vendor/settlements/today?restaurant_id=${restaurantId}`, {
    method: "PUT",
    credentials: "include",
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
  restaurantId: string,
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
  restaurantId: string,
): Promise<void> {
  const res = await fetch(`/api/vendor/gst-export?restaurant_id=${restaurantId}&month=${month}`, {
    credentials: "include",
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

export async function syncPosMenu(restaurantId: string): Promise<PosSyncResult> {
  return read<PosSyncResult>(
    await authedFetch(`/api/vendor/pos/sync-menu?restaurant_id=${restaurantId}`, {
      method: "POST",
    }),
  );
}

export async function simulatePosOrder(
  restaurantId: string,
): Promise<PosSimulateResult> {
  return read<PosSimulateResult>(
    await authedFetch(`/api/vendor/pos/simulate-order?restaurant_id=${restaurantId}`, {
      method: "POST",
    }),
  );
}

// ============================================
// Catalog (vendor-scoped restaurants)
// ============================================

/**
 * Fetches the restaurants the signed-in vendor is authorized to operate.
 * Role-gated on the server (VENDOR_OWNER / VENDOR_STAFF, plus ADMIN /
 * SUPER_ADMIN for platform oversight). Returns [] for an unknown vendor.
 */
export async function fetchVendorRestaurants(): Promise<VendorRestaurant[]> {
  return read<VendorRestaurant[]>(await authedFetch("/api/vendor/restaurants"));
}

// ============================================
// Vendor onboarding application (new merchant sign-up)
// ============================================

export interface VendorApplicationInput {
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  contact_email?: string;
  address?: string;
  city?: string;
  type?: "SINGLE" | "CHAIN";
  outlet_count?: number;
}

export interface VendorApplication {
  id: string;
  applicant_id: string;
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  type: "SINGLE" | "CHAIN";
  outlet_count: number;
  rejection_reason: string | null;
  created_at: string;
}

export async function requestOtp(phone: string): Promise<string> {
  const res = await fetch("/api/v1/auth/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(body.error?.message ?? "Failed to send OTP");
  return (body.data?.demoOtp as string) ?? "";
}

export async function verifyOtpForApply(phone: string, otp: string): Promise<string> {
  const res = await fetch("/api/v1/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp, device_fingerprint: "vendor-apply-fp-0001" }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(body.error?.message ?? "OTP verification failed");
  return body.data.access_token as string;
}

export async function submitVendorApplication(
  token: string,
  input: VendorApplicationInput,
): Promise<VendorApplication> {
  const res = await fetch("/api/v1/vendor-applications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!body.success) throw new Error(body.error?.message ?? "Application failed");
  return body.data as VendorApplication;
}

/**
 * Fetches the signed-in vendor's own onboarding applications (status page).
 * Uses the session-scoped authedFetch so a stale token silently refreshes.
 */
export async function fetchMyApplications(): Promise<VendorApplication[]> {
  return read<VendorApplication[]>(
    await authedFetch("/api/v1/vendor-applications/mine"),
  );
}

// ============================================
// Vendor sign-in / sign-up (phone + OTP)
// ============================================

export interface VendorAuthUser {
  id: string;
  phone: string;
  role: string;
}

export async function vendorSignup(phone: string): Promise<VendorAuthUser> {
  const res = await fetch("/api/v1/auth/vendor/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new ApiError(body.error?.message ?? "Sign up failed", body.error?.code, res.status);
  }
  return body.data as VendorAuthUser;
}

export async function vendorSendOtp(phone: string): Promise<string> {
  const res = await fetch("/api/v1/auth/vendor/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new ApiError(body.error?.message ?? "Failed to send OTP", body.error?.code, res.status);
  }
  return (body.data?.demoOtp as string) ?? "";
}

export async function vendorVerifyOtp(
  phone: string,
  otp: string,
  deviceFingerprint: string,
): Promise<{ access_token: string; user: VendorAuthUser }> {
  const res = await fetch("/api/v1/auth/vendor/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, otp, device_fingerprint: deviceFingerprint }),
  });
  const body = await res.json();
  if (!body.success) {
    throw new ApiError(body.error?.message ?? "OTP verification failed", body.error?.code, res.status);
  }
  return {
    access_token: body.data.access_token as string,
    user: body.data.user as VendorAuthUser,
  };
}
