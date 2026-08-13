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

interface UserDTO {
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

interface SupportTicketDTO {
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

export function fetchLiveOrders(status?: string): Promise<LiveOrdersResponse> {
  const qs = status ? `?status=${status}` : "";
  return adminFetch<LiveOrdersResponse>(`/orders${qs}`);
}

export function fetchOrderDetail(orderId: string): Promise<OrderDTO> {
  return adminFetch<OrderDTO>(`/orders/${orderId}`);
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

export function fetchUsers(page: number, search?: string): Promise<UserListResponse> {
  const qs = new URLSearchParams({ page: String(page), limit: "20" });
  if (search) qs.set("search", search);
  return adminFetch<UserListResponse>(`/users?${qs}`);
}

export function suspendUser(userId: string): Promise<UserDTO> {
  return adminFetch<UserDTO>(`/users/${userId}/suspend`, { method: "PUT" });
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
