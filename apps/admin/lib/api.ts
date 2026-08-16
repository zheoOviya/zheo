export interface HeatmapCell {
  lat: number;
  lng: number;
  count: number;
}

export interface HeatmapResult {
  window_minutes: number;
  total_orders: number;
  generated_at: string;
  cells: HeatmapCell[];
}

interface OrderDTO {
  id: string;
  status: string;
  total_amount: number;
  user_id: string;
  restaurant_id: string;
  created_at: string;
}

export interface OrderItemDTO {
  id: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customization_total: number;
  item_subtotal: number;
}

export interface OrderPaymentDTO {
  id: string;
  status: string;
  method: string | null;
  amount: number;
  currency: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  created_at: string;
}

export interface OrderCustomerDTO {
  id: string;
  phone: string;
  role: string;
  is_suspended: boolean;
}

export interface OrderRestaurantDTO {
  id: string;
  name: string;
  commission_rate: number;
}

export interface OrderDetailDTO extends OrderDTO {
  items?: OrderItemDTO[];
  commission_amount?: number;
  is_catering?: boolean;
  headcount?: number | null;
  scheduled_pickup_time?: string | null;
  payment: OrderPaymentDTO | null;
  customer: OrderCustomerDTO | null;
  restaurant: OrderRestaurantDTO | null;
}

export interface VendorMetricsDTO extends VendorDTO {
  owner_phone: string | null;
  order_count: number;
  completed_orders: number;
  revenue: number;
  commission: number;
  active_orders: number;
}

interface VendorDTO {
  id: string;
  name: string;
  gst_number: string | null;
  owner_id: string;
  commission_rate: number;
  is_active: boolean;
  owner_phone: string | null;
}

interface AuditEntry {
  id: string;
  actor_id: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface AuditPage {
  items: AuditEntry[];
  page: number;
  limit: number;
  total: number;
}

export interface UserDTO {
  id: string;
  phone: string;
  role: string;
  is_suspended: boolean;
  suspended_reason?: string | null;
  created_at: string;
}

export interface UserListResponse {
  items: UserDTO[];
  total: number;
}

export interface SupportTicketDTO {
  id: string;
  user_id: string;
  subject: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

interface TicketListResponse {
  items: SupportTicketDTO[];
  total: number;
}

export interface KillSwitchState {
  name: string;
  description: string;
  enabled: boolean;
  auto_trigger: boolean;
  trigger_condition: string;
  current_value: number | null;
  threshold: number;
  status: "ok" | "warning" | "triggered";
}

interface LiveOrdersResponse {
  orders: OrderDTO[];
  statusCounts: Record<string, number>;
  total: number;
}

export interface DashboardMetrics {
  daily_revenue: number;
  active_orders: number;
  total_orders_today: number;
  vendor_churn_pct: number;
  webhook_failure_pct: number;
  avg_pickup_time_min: number;
  cac_amount: number;
  ltv_amount: number;
  cac_ltv_ratio: number;
}

export interface HealthReport {
  status: "ok";
  storage_mode: "postgres" | "memory";
  redis: "reachable" | "degraded" | "memory";
  uptime_seconds: number;
  latency_ms: number;
  timestamp: string;
}

const ADMIN_API = "/api/v1/admin";

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("snkz_admin_token") : null;
  const res = await fetch(`${ADMIN_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const body = await res.json();
  if (!body.success || body.data === null || body.data === undefined) {
    throw new Error(body.error?.message ?? "Request failed");
  }
  return body.data;
}

export async function fetchHeatmap(): Promise<HeatmapResult> {
  // The heatmap lives on the public discovery router (`/api/v1/discovery/heatmap`),
  // not under the `/api/v1/admin` prefix used by `adminFetch`.
  const res = await fetch("/api/v1/discovery/heatmap");
  const body = await res.json();
  if (!body.success) {
    throw new Error(body.error?.message ?? "Request failed");
  }
  return body.data;
}

export function fetchDashboardMetrics(): Promise<DashboardMetrics> {
  return adminFetch<DashboardMetrics>("/metrics");
}

export function fetchHealth(): Promise<HealthReport> {
  return adminFetch<HealthReport>("/health");
}

export function fetchLiveOrders(status?: string): Promise<LiveOrdersResponse> {
  const qs = status ? `?status=${status}` : "";
  return adminFetch<LiveOrdersResponse>(`/orders${qs}`);
}

export function fetchOrderDetail(orderId: string): Promise<OrderDetailDTO> {
  return adminFetch<OrderDetailDTO>(`/orders/${orderId}`);
}

export function overrideOrderStatus(orderId: string, status: string, reason?: string): Promise<OrderDTO> {
  return adminFetch<OrderDTO>(`/orders/${orderId}/override-status`, {
    method: "POST",
    body: JSON.stringify({ status, reason }),
  });
}

export function fetchVendors(): Promise<(VendorDTO & { owner_phone: string | null })[]> {
  return adminFetch<VendorDTO[]>("/vendors");
}

export function fetchVendorMetrics(): Promise<VendorMetricsDTO[]> {
  return adminFetch<VendorMetricsDTO[]>("/vendors/metrics");
}

export function suspendVendor(vendorId: string): Promise<VendorDTO> {
  return adminFetch<VendorDTO>(`/vendors/${vendorId}/suspend`, { method: "PUT" });
}

export function reactivateVendor(vendorId: string): Promise<VendorDTO> {
  return adminFetch<VendorDTO>(`/vendors/${vendorId}/reactivate`, { method: "PUT" });
}

export function toggleVendorStatus(vendorId: string, isActive: boolean): Promise<VendorDTO> {
  return adminFetch<VendorDTO>(`/vendors/${vendorId}/status`, {
    method: "PUT",
    body: JSON.stringify({ is_active: isActive }),
  });
}

export type VendorApplicationStatus = "PENDING" | "APPROVED" | "REJECTED";
export type VendorApplicationType = "SINGLE" | "CHAIN";

export interface VendorApplicationDTO {
  id: string;
  applicant_id: string;
  name: string;
  gst_number: string;
  fssai_license: string;
  phone: string;
  contact_email: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  commission_rate: number;
  status: VendorApplicationStatus;
  type: VendorApplicationType;
  outlet_count: number;
  rejection_reason: string | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export function fetchVendorApplications(status?: VendorApplicationStatus): Promise<VendorApplicationDTO[]> {
  const qs = status ? `?status=${status}` : "";
  return adminFetch<VendorApplicationDTO[]>(`/vendor-applications${qs}`);
}

export interface VendorApplicationTrendPoint {
  date: string;
  submitted: number;
  approved: number;
  rejected: number;
}

export interface VendorApplicationMetrics {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  trend: VendorApplicationTrendPoint[];
}

export function fetchVendorApplicationMetrics(days = 14): Promise<VendorApplicationMetrics> {
  return adminFetch<VendorApplicationMetrics>(`/vendor-applications/metrics?days=${days}`);
}

export function approveVendorApplication(id: string): Promise<{ application: VendorApplicationDTO; restaurant: { id: string; name: string } }> {
  return adminFetch(`/vendor-applications/${id}/approve`, { method: "PUT" });
}

export function rejectVendorApplication(id: string, reason?: string): Promise<VendorApplicationDTO> {
  return adminFetch(`/vendor-applications/${id}/reject`, {
    method: "PUT",
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
}

export function fetchAuditLogs(params?: {
  page?: number;
  limit?: number;
  action?: string;
  actor_id?: string;
}): Promise<AuditPage> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.action) qs.set("action", params.action);
  if (params?.actor_id) qs.set("actor_id", params.actor_id);
  const q = qs.toString();
  return adminFetch<AuditPage>(`/audit-logs${q ? `?${q}` : ""}`);
}

export function fetchKillSwitches(): Promise<KillSwitchState[]> {
  return adminFetch<KillSwitchState[]>("/kill-switches");
}

export function toggleKillSwitch(name: string, enabled: boolean): Promise<KillSwitchState> {
  return adminFetch<KillSwitchState>(`/kill-switches/${name}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function fetchUsers(page: number, search?: string, role?: string): Promise<UserListResponse> {
  const qs = new URLSearchParams({ page: String(page), limit: "20" });
  if (search) qs.set("search", search);
  if (role) qs.set("role", role);
  return adminFetch<UserListResponse>(`/users?${qs}`);
}

export function suspendUser(userId: string, reason?: string): Promise<UserDTO> {
  return adminFetch<UserDTO>(`/users/${userId}/suspend`, {
    method: "PUT",
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
}

export function reactivateUser(userId: string): Promise<UserDTO> {
  return adminFetch<UserDTO>(`/users/${userId}/reactivate`, { method: "PUT" });
}

export function updateUserRole(userId: string, role: string): Promise<UserDTO> {
  return adminFetch<UserDTO>(`/users/${userId}/role`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export interface VipStatusDTO {
  is_vip: boolean;
  order_count: number;
  total_spend: number;
  order_threshold: number;
  spend_threshold: number;
}

export interface WalletDTO {
  user_id: string;
  balance: number;
  total_earned: number;
}

export interface WalletTransactionDTO {
  id: string;
  user_id: string;
  amount: number;
  reason: string;
  balance_after: number;
  created_at: string;
}

export interface StampCardDTO {
  user_id: string;
  restaurant_id: string;
  stamp_count: number;
  total_orders: number;
  rewards_earned: number;
  reward_type: string;
  updated_at: string;
}

export interface StreakDTO {
  user_id: string;
  current_streak: number;
  best_streak: number;
  last_pickup_day: string | null;
  updated_at: string;
}

export interface ReferralClaimDTO {
  id: string;
  claimant_user_id: string;
  referrer_user_id: string;
  referral_code: string;
  bonus_amount: number;
  ip_address: string | null;
  device_fingerprint: string | null;
  created_at: string;
}

export interface Customer360DTO {
  user: UserDTO;
  vip: VipStatusDTO;
  summary: { total_spend: number; order_count: number; average_order_value: number };
  wallet: WalletDTO;
  wallet_transactions: WalletTransactionDTO[];
  stamp_cards: StampCardDTO[];
  streak: StreakDTO;
  referral_code: string;
  referrals_given: ReferralClaimDTO[];
  referrals_claimed: ReferralClaimDTO[];
  tickets: SupportTicketDTO[];
  orders: OrderDTO[];
}

export function fetchCustomer360(userId: string): Promise<Customer360DTO> {
  return adminFetch<Customer360DTO>(`/customers/${userId}/360`);
}

export interface RevenueSeriesPoint {
  date: string;
  revenue: number;
  orders: number;
  commission: number;
}

export interface RevenueReportDTO {
  days: number;
  series: RevenueSeriesPoint[];
  totals: { revenue: number; orders: number; commission: number; average_order_value: number };
  payment_split: Record<string, number>;
  top_vendors: { restaurant_id: string; name: string; revenue: number; orders: number }[];
}

export function fetchRevenue(days: number = 7): Promise<RevenueReportDTO> {
  return adminFetch<RevenueReportDTO>(`/revenue?days=${days}`);
}

export interface RoleDefinition {
  name: string;
  label: string;
  description: string;
  permissions: string[];
  is_builtin: boolean;
  member_count: number;
}

export function fetchRoles(): Promise<RoleDefinition[]> {
  return adminFetch<RoleDefinition[]>("/roles");
}

export function createRole(input: {
  name: string;
  label: string;
  description: string;
  permissions: string[];
}): Promise<RoleDefinition> {
  return adminFetch<RoleDefinition>("/roles", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteRole(name: string): Promise<{ removed: string }> {
  return adminFetch<{ removed: string }>(`/roles/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function fetchSupportTickets(params: {
  page: number;
  status?: string;
  priority?: string;
}): Promise<TicketListResponse> {
  const qs = new URLSearchParams({ page: String(params.page), limit: "20" });
  if (params.status) qs.set("status", params.status);
  if (params.priority) qs.set("priority", params.priority);
  return adminFetch<TicketListResponse>(`/support-tickets?${qs}`);
}

export function fetchSupportTicket(id: string): Promise<SupportTicketDTO> {
  return adminFetch<SupportTicketDTO>(`/support-tickets/${id}`);
}

export function updateSupportTicket(
  ticketId: string,
  patch: { status?: string; assignee?: string | null },
): Promise<SupportTicketDTO> {
  return adminFetch<SupportTicketDTO>(`/support-tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function getSessionRoles(): Promise<string[]> {
  try {
    const token = typeof window !== "undefined" ? localStorage.getItem("snkz_admin_token") : null;
    if (!token) return [];
    const payload = JSON.parse(atob(token.split(".")[1]!));
    return payload.role ? [payload.role] : [];
  } catch {
    return [];
  }
}
