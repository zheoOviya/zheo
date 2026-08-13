export interface Restaurant {
  id: string;
  name: string;
  commission_rate: number;
  is_active: boolean;
  lat: number | null;
  lng: number | null;
  /** Estimated prep/pickup time in minutes (shown on home cards). */
  pickup_eta_min: number;
}

export interface MenuItem {
  id: string;
  restaurant_id: string;
  name: string;
  price: number;
  image_url: string | null;
  dietary_tags: Record<string, boolean>;
  customizations: unknown[];
  is_available: boolean;
  /** D03 spice level (1 = mild, 5 = extreme). */
  spice_level: number;
}

export interface SearchResult {
  type: "restaurant" | "dish";
  id: string;
  name: string;
  restaurant_id?: string;
}

// Browser fetches use relative /api/* URLs (routed through the Next.js
// rewrite to the API server). Server-side fetches (RSC) need an absolute
// origin, so fall back to the local API server when no env override is set.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? (typeof window === "undefined" ? "http://localhost:3001" : "");

async function fetcher<T>(
  path: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    cache: "no-store",
    headers,
  });
  const body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string } | null;
  } = await res.json();
  if (!body.success || body.data === null) {
    throw new Error(body.error?.message ?? "Request failed");
  }
  return body.data;
}

export function fetchRestaurants(): Promise<Restaurant[]> {
  return fetcher<Restaurant[]>("/api/v1/restaurants");
}

export function fetchRestaurantMenu(restaurantId: string): Promise<MenuItem[]> {
  return fetcher<MenuItem[]>(`/api/v1/restaurants/${encodeURIComponent(restaurantId)}/menu`);
}

export function searchAutocomplete(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  return fetcher<SearchResult[]>(`/api/v1/search/autocomplete?q=${encodeURIComponent(q)}`, signal);
}

export function filterMenuByDietary(tags: string[]): Promise<MenuItem[]> {
  return fetcher<MenuItem[]>(
    `/api/v1/menu-items/filter?dietary=${encodeURIComponent(tags.join(","))}`,
  );
}

// ============================================
// Loyalty (L05 Refer & Earn + L01 Stamp Cards)
// Client-side only - requires the access token.
// ============================================

export interface ReferralProfile {
  referral_code: string;
  bonus_amount: number;
  balance: number;
  total_earned: number;
}

export interface StampCard {
  user_id: string;
  restaurant_id: string;
  stamp_count: number;
  total_orders: number;
  rewards_earned: number;
  reward_type: "FREE_ITEM";
  updated_at: string;
}

export interface TrafficEta {
  eta_seconds: number;
  duration_text: string;
  distance_km: number;
  source: "google" | "mock";
}

async function authedFetcher<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  const body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string } | null;
  } = await res.json();
  if (!body.success || body.data === null) {
    const err = new Error(body.error?.message ?? "Request failed") as Error & {
      code?: string;
    };
    err.code = body.error?.code;
    throw err;
  }
  return body.data;
}

export function fetchReferralProfile(token: string): Promise<ReferralProfile> {
  return authedFetcher<ReferralProfile>("/api/v1/loyalty/referral", token);
}

export function applyReferral(token: string, code: string): Promise<unknown> {
  return authedFetcher<unknown>("/api/v1/loyalty/apply-referral", token, {
    method: "POST",
    body: JSON.stringify({ referral_code: code }),
  });
}

export function fetchStampCards(token: string): Promise<StampCard[]> {
  return authedFetcher<StampCard[]>("/api/v1/loyalty/stamp-cards", token);
}

export function fetchStampCard(token: string, restaurantId: string): Promise<StampCard> {
  return authedFetcher<StampCard>(
    `/api/v1/loyalty/stamp-cards/${encodeURIComponent(restaurantId)}`,
    token,
  );
}

// ============================================
// O12 SnakZap Wallet & Cashback + L02 Pickup Streak (Phase 3)
// ============================================

export interface WalletTransaction {
  id: string;
  user_id: string;
  amount: number;
  reason: "referral_bonus" | "pickup_cashback";
  balance_after: number;
  created_at: string;
}

export interface WalletData {
  user_id: string;
  balance: number;
  total_earned: number;
  transactions: WalletTransaction[];
}

export interface StreakData {
  current_streak: number;
  best_streak: number;
  last_pickup_day: string | null;
  days_to_next_badge: number;
}

export function fetchWallet(token: string): Promise<WalletData> {
  return authedFetcher<WalletData>("/api/v1/loyalty/wallet", token);
}

export function fetchStreak(token: string): Promise<StreakData> {
  return authedFetcher<StreakData>("/api/v1/loyalty/streak", token);
}

// ============================================
// D03 Spice Tolerance Profile (Phase 3)
// ============================================

export interface SpiceProfile {
  user_id: string;
  phone: string;
  spice_tolerance: number | null;
}

export function updateSpiceTolerance(token: string, spiceTolerance: number): Promise<SpiceProfile> {
  return authedFetcher<SpiceProfile>("/api/v1/users/profile", token, {
    method: "PUT",
    body: JSON.stringify({ spice_tolerance: spiceTolerance }),
  });
}

// ============================================
// O09 Cart Persistence (Phase 3)
// ============================================

export interface PersistedCartItem {
  menu_item_id: string;
  quantity: number;
  name?: string;
  base_price?: number;
  customizations?: { name: string; price_delta: number }[];
  restaurant_id?: string;
}

export interface PersistedCart {
  items: PersistedCartItem[];
  expired: boolean;
  saved_at: string | null;
  restaurant_id: string | null;
  restaurant_name: string | null;
}

export function fetchPersistedCart(token: string): Promise<PersistedCart> {
  return authedFetcher<PersistedCart>("/api/v1/cart", token);
}

export function savePersistedCart(
  token: string,
  cart: {
    restaurant_id?: string | null;
    restaurant_name?: string | null;
    items: PersistedCartItem[];
  },
): Promise<{ saved: boolean; item_count: number }> {
  return authedFetcher<{ saved: boolean; item_count: number }>("/api/v1/cart", token, {
    method: "POST",
    body: JSON.stringify(cart),
  });
}

export function clearPersistedCart(token: string): Promise<{ cleared: boolean }> {
  return authedFetcher<{ cleared: boolean }>("/api/v1/cart", token, {
    method: "DELETE",
  });
}

// ============================================
// P04 Traffic-based ETA (public)
// ============================================

export function fetchTrafficEta(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<TrafficEta> {
  const qs = new URLSearchParams({
    origin_lat: String(origin.lat),
    origin_lng: String(origin.lng),
    destination_lat: String(destination.lat),
    destination_lng: String(destination.lng),
  });
  return fetcher<TrafficEta>(`/api/v1/eta?${qs.toString()}`);
}

// ============================================
// Sprint 1 (I-03): Order History + Re-Order
// ============================================

export interface OrderHistoryItem {
  id: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: unknown[];
  customization_total: number;
  item_subtotal: number;
}

export interface OrderHistoryEntry {
  id: string;
  user_id: string;
  restaurant_id: string;
  restaurant_name: string | null;
  status: string;
  total_amount: number;
  commission_rate: number;
  commission_amount: number;
  pickup_otp: string | null;
  qr_token: string | null;
  checked_in: boolean;
  scheduled_pickup_time: string | null;
  created_at: string;
  updated_at: string;
  items: OrderHistoryItem[];
}

export interface OrderHistoryPage {
  orders: OrderHistoryEntry[];
  next_cursor: string | null;
}

export function fetchOrderHistory(
  token: string,
  cursor?: string,
  limit = 10,
): Promise<OrderHistoryPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return authedFetcher<OrderHistoryPage>(`/api/v1/orders?${params.toString()}`, token);
}

export function fetchOrderById(token: string, orderId: string): Promise<OrderHistoryEntry> {
  return authedFetcher<OrderHistoryEntry>(`/api/v1/orders/${encodeURIComponent(orderId)}`, token);
}

export function reorderOrder(
  token: string,
  oldOrderId: string,
): Promise<{ id: string; status: string; total_amount: number }> {
  return authedFetcher<{ id: string; status: string; total_amount: number }>(
    "/api/v1/orders/reorder",
    token,
    {
      method: "POST",
      body: JSON.stringify({ old_order_id: oldOrderId }),
    },
  );
}

// ============================================
// Payments (client-side only - requires auth)
// ============================================

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet" | "cod";

export interface CreateOrderResponse {
  /** "cod" orders are paid at the counter and skip the Razorpay checkout. */
  payment_method: PaymentMethod;
  razorpay_order_id?: string;
  amount: number;
  currency: string;
}

export async function createPaymentOrder(
  orderId: string,
  token: string,
  method: PaymentMethod = "upi",
): Promise<CreateOrderResponse> {
  const res = await fetch(`${API_BASE}/api/v1/payments/create-order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ order_id: orderId, method }),
    credentials: "include",
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(body.error?.message ?? "Payment creation failed");
  }
  return body.data;
}

// Phase-1 demo: replay a Razorpay webhook client-side so the server order
// state reflects the simulated outcome (DRAFT -> PAYMENT_PENDING -> CONFIRMED
// / PAYMENT_FAILED). In mock mode the API accepts signatures starting with
// "valid_sig_"; production uses the real Razorpay checkout instead.
export async function simulatePaymentWebhook(
  razorpayOrderId: string,
  amount: number,
  success: boolean,
): Promise<{ orderStatus: string }> {
  const mockPaymentId = `pay_mock_${Math.random().toString(36).slice(2, 10)}`;
  const signature = `valid_sig_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    event: success ? "payment.captured" : "payment.failed",
    payload: {
      payment: {
        entity: {
          id: mockPaymentId,
          order_id: razorpayOrderId,
          amount: Math.round(amount * 100),
          status: success ? "captured" : "failed",
          captured: success,
          method: "upi",
          description: success ? undefined : "Payment failed",
        },
      },
    },
  };

  const res = await fetch(`${API_BASE}/api/v1/payments/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(body.error?.message ?? "Payment processing failed");
  }
  return { orderStatus: body.data?.order_status ?? "" };
}

// ============================================
// Phase 3 Discovery (D07 Personalized Homepage + D17 Trending Now)
// ============================================

export interface PersonalizedRestaurant {
  restaurant: Restaurant;
  reason: string;
  score: number;
}

export interface PersonalizedHomepage {
  user_profile: {
    is_cold_start: boolean;
    past_order_count: number;
    inferred_dietary_tags: string[];
    strategy: "rule_based" | "ml_weighted";
  };
  personalized_restaurants: PersonalizedRestaurant[];
  surprise_restaurant: PersonalizedRestaurant | null;
}

export function fetchPersonalizedHomepage(token?: string): Promise<PersonalizedHomepage> {
  return fetcher<PersonalizedHomepage>(
    "/api/v1/discovery/personalized-homepage",
    undefined,
    token ? { Authorization: `Bearer ${token}` } : undefined,
  );
}

export interface TrendingDish {
  menu_item_id: string;
  name: string;
  price: number;
  restaurant_id: string;
  restaurant_name: string;
  orders_count: number;
  quantity_sold: number;
}

export interface TrendingResponse {
  window_minutes: number;
  radius_km: number;
  location: { lat: number; lng: number };
  generated_at: string;
  trending: TrendingDish[];
}

export function fetchTrending(params?: {
  radius_km?: number;
  minutes?: number;
}): Promise<TrendingResponse> {
  const qs = new URLSearchParams();
  if (params?.radius_km) qs.set("radius_km", String(params.radius_km));
  if (params?.minutes) qs.set("minutes", String(params.minutes));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return fetcher<TrendingResponse>(`/api/v1/discovery/trending${suffix}`);
}

// ============================================
// Group Order (O02) - shareable cart, live contributors
// ============================================

export interface GroupCartCreateResponse {
  group_cart_token: string;
  order_id: string;
  restaurant_id: string;
  created_at: string;
  share_link: string;
}

export interface GroupCartContributionItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
}

export interface GroupCartContributor {
  user_id: string;
  display_name: string;
  avatar_seed: string;
  added_at: string;
  items: GroupCartContributionItem[];
}

export interface GroupOrderLine {
  id: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: unknown[];
  customization_total: number;
  item_subtotal: number;
}

export interface GroupCartSnapshot {
  group_cart_token: string;
  restaurant_id: string;
  order_id: string;
  status: string;
  item_count: number;
  total_amount: number;
  items: GroupOrderLine[];
  contributors: GroupCartContributor[];
  updated_at: string;
}

export function createGroupCart(
  token: string,
  restaurantId: string,
): Promise<GroupCartCreateResponse> {
  return authedFetcher<GroupCartCreateResponse>("/api/v1/orders/group/create", token, {
    method: "POST",
    body: JSON.stringify({ restaurant_id: restaurantId }),
  });
}

export function addToGroupCart(
  token: string,
  groupCartToken: string,
  items: { menu_item_id: string; quantity: number; customizations: unknown[] }[],
): Promise<{
  order: unknown;
  cart: { item_count: number; total_amount: number; contributors: GroupCartContributor[] };
}> {
  return authedFetcher("/api/v1/orders/group/add", token, {
    method: "POST",
    body: JSON.stringify({
      group_cart_token: groupCartToken,
      items,
    }),
  });
}

export function fetchGroupCart(groupCartToken: string): Promise<GroupCartSnapshot> {
  return fetcher<GroupCartSnapshot>(
    `/api/v1/orders/group/cart?token=${encodeURIComponent(groupCartToken)}`,
  );
}

// ============================================
// L15 VIP Customer Support (Phase 4)
// VIP = orders > 50 OR spend > Rs 5000. VIP tickets are auto-routed to a
// specialized OPS_AGENT at HIGH priority.
// ============================================

export interface VipStatus {
  is_vip: boolean;
  order_count: number;
  total_spend: number;
  order_threshold: number;
  spend_threshold: number;
}

export interface SupportTicketResult {
  id: string;
  subject: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  assignee: string | null;
  is_vip: boolean;
  created_at: string;
}

export function fetchVipStatus(token: string): Promise<VipStatus> {
  return authedFetcher<VipStatus>("/api/v1/support/vip-status", token);
}

export function createSupportTicket(
  token: string,
  subject: string,
  description: string,
): Promise<SupportTicketResult> {
  return authedFetcher<SupportTicketResult>("/api/v1/support/ticket", token, {
    method: "POST",
    body: JSON.stringify({ subject, description }),
  });
}
