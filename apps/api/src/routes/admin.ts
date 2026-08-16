import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { adminReadOnly, adminWrite, superAdminOnly } from "../middleware/requireRoles";
import { rateLimiter } from "../middleware/rateLimiter";
import {
  sharedAuditRepo,
  sharedOrderRepo,
  sharedIdentityRepo,
  sharedKillSwitchRepo,
  sharedSupportRepo,
  sharedRoleRepo,
  sharedPaymentRepo,
  sharedLoyaltyRepo,
  sharedVendorApplicationRepo,
  sharedUserRoleRepo,
  sharedChainRepo,
  getStorageMode,
} from "../repositories/shared";
import { getRedis } from "../lib/redis";
import { config } from "../config";
import { emit, createEventEnvelope } from "../lib/eventBus";
import { getCatalogRepository } from "./catalog";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import type { KillSwitchDTO } from "../repositories/killSwitchRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import { VipSupportService } from "../services/vipSupport";

const adminRouter: Router = Router();

const adminWriteLimiter = rateLimiter({
  prefix: "admin-write",
  max: 30,
  windowMs: 60_000,
  identifier: (req) => req.ip ?? "unknown",
  failClosed: true,
});

/** Orders that count toward completed revenue / settlement math. */
const REVENUE_COMPLETED_STATUSES = new Set(["PICKED_UP", "SETTLED"]);

// ============================================
// System Health (A-11) — live component status
// ============================================

adminRouter.get(
  "/health",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const started = Date.now();
    const storageMode = getStorageMode();
    let redisStatus: "reachable" | "degraded" | "memory";
    if (process.env.NODE_ENV === "test" || !config.redis.url) {
      redisStatus = "memory";
    } else {
      try {
        const pong = await Promise.race([
          getRedis().ping(),
          new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), 1500)),
        ]);
        redisStatus = pong === "PONG" ? "reachable" : "degraded";
      } catch {
        redisStatus = "degraded";
      }
    }
    ok(res, {
      status: "ok",
      storage_mode: storageMode,
      redis: redisStatus,
      uptime_seconds: Math.round(process.uptime()),
      latency_ms: Date.now() - started,
      timestamp: new Date().toISOString(),
    });
  }),
);

// ============================================
// Kill Switches (A-03) — Sprint 5.1: DB-persisted
// ============================================

interface KillSwitchState {
  name: string;
  description: string;
  enabled: boolean;
  auto_trigger: boolean;
  trigger_condition: string;
  current_value: number | null;
  threshold: number;
  status: "ok" | "warning" | "triggered";
}

const SWITCH_META: Record<string, Omit<KillSwitchState, "enabled" | "current_value" | "threshold" | "status">> = {
  vendor_churn_protection: {
    name: "Vendor Churn Protection",
    description: "Auto-suspends vendor onboarding when churn > 10%",
    auto_trigger: true,
    trigger_condition: "vendor_churn_pct > 10",
  },
  cac_gtv_protection: {
    name: "CAC vs LTV Protection",
    description: "Blocks paid acquisition channels when CAC > LTV",
    auto_trigger: true,
    trigger_condition: "cac > ltv",
  },
  webhook_fallback: {
    name: "Webhook Fallback",
    description: "Routes payments to manual fallback when webhook failure > 1%",
    auto_trigger: true,
    trigger_condition: "webhook_failure_pct > 1.0",
  },
};

function toKillSwitchState(dto: KillSwitchDTO): KillSwitchState {
  const meta = SWITCH_META[dto.switch_name] ?? {
    name: dto.switch_name,
    description: "",
    auto_trigger: false,
    trigger_condition: "",
  };
  return {
    ...meta,
    enabled: dto.is_triggered,
    current_value: dto.current_value,
    threshold: dto.threshold_value,
    status: dto.is_triggered ? "triggered" : "ok",
  };
}

// ============================================
// Role catalog (custom roles, admin console)
// Built-in roles are static; SUPER_ADMINs may add/remove custom roles.
// ============================================

export const BUILTIN_ROLES: Array<{
  name: string;
  label: string;
  description: string;
  permissions: string[];
}> = [
  {
    name: "CONSUMER",
    label: "Consumer",
    description: "End users who browse, order, and track food deliveries.",
    permissions: ["Place & track orders", "Group ordering", "Loyalty & VIP tiers"],
  },
  {
    name: "VENDOR_OWNER",
    label: "Vendor Owner",
    description: "Restaurant owners running their own outlet on the platform.",
    permissions: ["Manage menu & catalog", "Accept orders", "View revenue & commissions"],
  },
  {
    name: "VENDOR_STAFF",
    label: "Vendor Staff",
    description: "Outlet staff who prepare and hand off orders.",
    permissions: ["Prepare orders", "Update order statuses", "POS terminal access"],
  },
  {
    name: "OPS_AGENT",
    label: "Ops Agent",
    description: "Operations agents who triage support and keep things moving.",
    permissions: ["Triage support tickets", "Escalate delays", "Read-only console views"],
  },
  {
    name: "ADMIN",
    label: "Admin",
    description: "Console operators with day-to-day management controls.",
    permissions: ["Suspend & reactivate users", "Manage vendors", "Oversee orders & tickets"],
  },
  {
    name: "SUPER_ADMIN",
    label: "Super Admin",
    description: "Full control: roles, kill switches, order overrides, and audit.",
    permissions: ["All Admin permissions", "Change user roles", "Override order status", "Toggle kill switches"],
  },
];

const ROLE_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

function isBuiltinRole(name: string): boolean {
  return BUILTIN_ROLES.some((b) => b.name === name);
}

async function roleExists(name: string): Promise<boolean> {
  return isBuiltinRole(name) || (await sharedRoleRepo.getByName(name)) !== null;
}

/** Operator roles with elevated console privileges. A plain ADMIN must not
 *  suspend/reactivate/demote these accounts. */
function isOperatorRole(role: string): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** Number of non-suspended users currently holding the given role. */
async function countActiveByRole(role: string): Promise<number> {
  const { items } = await sharedIdentityRepo.listAll(1, 10_000, undefined, role);
  return items.filter((u) => !u.is_suspended).length;
}

const CreateRoleSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(40)
    .regex(ROLE_NAME_REGEX, "Role name must be SCREAMING_SNAKE_CASE, e.g. SUPPORT_LEAD"),
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  permissions: z.array(z.string().min(1).max(80)).max(20).default([]),
});

adminRouter.get(
  "/kill-switches",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    const all = await sharedKillSwitchRepo.getAll();
    ok(res, all.map(toKillSwitchState));
  }),
);

const ToggleKillSwitchSchema = z.object({
  enabled: z.boolean(),
});

adminRouter.put(
  "/kill-switches/:id",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const switchName = req.params.id as string;
    const body = ToggleKillSwitchSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid toggle payload", 400, body.error.flatten());
    }
    const existing = await sharedKillSwitchRepo.getByName(switchName);
    if (!existing) {
      throw new AppError("NOT_FOUND", `Kill switch '${switchName}' not found`, 404);
    }
    const updated = await sharedKillSwitchRepo.upsert(switchName, {
      is_triggered: body.data.enabled,
      threshold_value: existing.threshold_value,
      current_value: existing.current_value,
    });
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(
      actorId,
      body.data.enabled ? "kill_switch_activated" : "kill_switch_deactivated",
      { switch_name: switchName },
    );
    ok(res, toKillSwitchState(updated));
  }),
);

// ============================================
// Audit Logs (A-05)
// ============================================

adminRouter.get(
  "/audit-logs",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const actorId = typeof req.query.actor_id === "string" ? req.query.actor_id : undefined;

    const allLogs = await sharedAuditRepo.all(1000);
    let filtered = allLogs;
    if (action) filtered = filtered.filter((l) => l.action === action);
    if (actorId) filtered = filtered.filter((l) => l.actor_id === actorId);

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);

    ok(res, { items, page, limit, total });
  }),
);

// ============================================
// Live Orders (A-08)
// ============================================

adminRouter.get(
  "/orders",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const allOrders = await sharedOrderRepo.getAll();
    const live = allOrders.filter((o) =>
      !["DRAFT", "PAYMENT_FAILED", "CANCELLED", "EXPIRED", "DISPUTED", "REFUNDED", "PICKED_UP", "SETTLED"].includes(o.status),
    );
    const filtered = status ? live.filter((o) => o.status === status) : live;
    const counts: Record<string, number> = {};
    for (const s of ["CONFIRMED", "PREPARING", "ALMOST_READY", "READY_FOR_PICKUP"]) {
      counts[s] = live.filter((o) => o.status === s).length;
    }
    ok(res, { orders: filtered.slice(0, 50), statusCounts: counts, total: live.length });
  }),
);

adminRouter.get(
  "/orders/:id",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const order = await sharedOrderRepo.getById(id);
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found", 404);
    }
    const payment = await sharedPaymentRepo.getByOrderId(id).catch(() => null);
    const customer = await sharedIdentityRepo.getById(order.user_id).catch(() => null);
    const repo = getCatalogRepository();
    const restaurant = await repo.getRestaurantById(order.restaurant_id).catch(() => null);
    ok(res, {
      ...order,
      payment: payment
        ? {
            id: payment.id,
            status: payment.status,
            method: payment.method,
            amount: payment.amount,
            currency: payment.currency,
            razorpay_order_id: payment.razorpay_order_id,
            razorpay_payment_id: payment.razorpay_payment_id,
            created_at: payment.created_at,
          }
        : null,
      customer: customer
        ? { id: customer.id, phone: customer.phone, role: customer.role, is_suspended: customer.is_suspended }
        : null,
      restaurant: restaurant
        ? { id: restaurant.id, name: restaurant.name, commission_rate: restaurant.commission_rate }
        : null,
    });
  }),
);

const VALID_ORDER_STATUSES = [
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "SETTLED",
  "CANCELLED",
] as const;

const OverrideOrderSchema = z.object({
  status: z.enum(VALID_ORDER_STATUSES),
  reason: z.string().min(1).optional(),
});

adminRouter.post(
  "/orders/:id/override-status",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const actorRole = res.locals.userRole as string;
    if (actorRole !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only SUPER_ADMIN can override order status", 403);
    }
    const body = OverrideOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid override payload", 400, body.error.flatten());
    }
    const order = await sharedOrderRepo.getById(id);
    if (!order) {
      throw new AppError("NOT_FOUND", "Order not found", 404);
    }
    const updated = await sharedOrderRepo.updateStatus(id, body.data.status);
    if (!updated) {
      throw new AppError("NOT_FOUND", "Order not found", 404);
    }
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "order_status_overridden", {
      order_id: id,
      previous_status: order.status,
      new_status: body.data.status,
      reason: body.data.reason ?? null,
    });
    ok(res, updated);
  }),
);

// ============================================
// Vendor Management (A-04) — Sprint 5.1: suspend/reactivate
// ============================================

adminRouter.get(
  "/vendors",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    const repo = getCatalogRepository();
    const restaurants = await repo.getAllRestaurants();
    const withOwners = await Promise.all(
      restaurants.map(async (r) => {
        try {
          const owner = await sharedIdentityRepo.getById(r.owner_id);
          return { ...r, owner_phone: owner?.phone ?? null };
        } catch {
          return { ...r, owner_phone: null };
        }
      }),
    );
    ok(res, withOwners);
  }),
);

adminRouter.put(
  "/vendors/:id/suspend",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const repo = getCatalogRepository();
    const restaurant = await repo.getRestaurantById(id);
    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Vendor not found", 404);
    }
    if (!restaurant.is_active) {
      throw new AppError("CONFLICT", "Vendor is already suspended", 409);
    }
    await repo.updateRestaurantStatus(id, false);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "vendor_suspended", {
      vendor_id: id,
      vendor_name: restaurant.name,
    });
    ok(res, { ...restaurant, is_active: false });
  }),
);

adminRouter.put(
  "/vendors/:id/reactivate",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const repo = getCatalogRepository();
    const restaurant = await repo.getRestaurantById(id);
    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Vendor not found", 404);
    }
    if (restaurant.is_active) {
      throw new AppError("CONFLICT", "Vendor is already active", 409);
    }
    await repo.updateRestaurantStatus(id, true);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "vendor_reactivated", {
      vendor_id: id,
      vendor_name: restaurant.name,
    });
    ok(res, { ...restaurant, is_active: true });
  }),
);

// Legacy PUT /vendors/:id/status kept for backward compatibility with existing UI
adminRouter.put(
  "/vendors/:id/status",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const body = z.object({ is_active: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid vendor status payload", 400, body.error.flatten());
    }
    const repo = getCatalogRepository();
    const restaurant = await repo.getRestaurantById(id);
    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Vendor not found", 404);
    }
    await repo.updateRestaurantStatus(id, body.data.is_active);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, body.data.is_active ? "vendor_reactivated" : "vendor_suspended", {
      vendor_id: id,
      vendor_name: restaurant.name,
    });
    ok(res, { ...restaurant, is_active: body.data.is_active });
  }),
);

// ============================================
// Vendor Onboarding Applications (marketplace)
// Admins review PENDING applications and approve (creating the restaurant +
// upgrading the applicant to VENDOR_OWNER) or reject with a reason.
// ============================================

const RejectApplicationSchema = z.object({
  reason: z.string().min(2).max(300).optional(),
});

adminRouter.get(
  "/vendor-applications",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const apps = await sharedVendorApplicationRepo.listAll(status as never);
    ok(res, apps);
  }),
);

adminRouter.get(
  "/vendor-applications/metrics",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days ?? "14"), 10) || 14));
    const metrics = await sharedVendorApplicationRepo.getMetrics(days);
    ok(res, metrics);
  }),
);

adminRouter.put(
  "/vendor-applications/:id/approve",
  adminWriteLimiter, superAdminOnly,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const actorId = res.locals.userId as string;
    const app = await sharedVendorApplicationRepo.getById(id);
    if (!app) {
      throw new AppError("NOT_FOUND", "Application not found", 404);
    }
    if (app.status !== "PENDING") {
      throw new AppError("CONFLICT", `Application is already ${app.status.toLowerCase()}`, 409);
    }
    const repo = getCatalogRepository();

    let restaurant: RestaurantDTO;
    let chainId: string | null = null;
    let outletIds: string[] = [];

    if (app.type === "CHAIN") {
      const chain = await sharedChainRepo.create(app.name, app.applicant_id);
      chainId = chain.id;
      const count = Math.max(1, app.outlet_count);
      restaurant = await repo.createRestaurant({
        name: count > 1 ? `${app.name} — Outlet 1` : app.name,
        gst_number: app.gst_number,
        fssai_license: app.fssai_license,
        owner_id: app.applicant_id,
        commission_rate: app.commission_rate,
        lat: app.lat,
        lng: app.lng,
        pickup_eta_min: 20,
        chain_id: chain.id,
      });
      outletIds.push(restaurant.id);
      for (let i = 2; i <= count; i += 1) {
        const outlet = await repo.createRestaurant({
          name: `${app.name} — Outlet ${i}`,
          gst_number: app.gst_number,
          fssai_license: app.fssai_license,
          owner_id: app.applicant_id,
          commission_rate: app.commission_rate,
          lat: app.lat,
          lng: app.lng,
          pickup_eta_min: 20,
          chain_id: chain.id,
        });
        outletIds.push(outlet.id);
      }
    } else {
      restaurant = await repo.createRestaurant({
        name: app.name,
        gst_number: app.gst_number,
        fssai_license: app.fssai_license,
        owner_id: app.applicant_id,
        commission_rate: app.commission_rate,
        lat: app.lat,
        lng: app.lng,
        pickup_eta_min: 20,
      });
    }

    await sharedIdentityRepo.updateRole(app.applicant_id, "VENDOR_OWNER");
    if (chainId) {
      await sharedUserRoleRepo.assign({
        user_id: app.applicant_id,
        scope_type: "chain",
        scope_id: chainId,
        role: "VENDOR_OWNER",
      });
    } else {
      await sharedUserRoleRepo.assign({
        user_id: app.applicant_id,
        scope_type: "restaurant",
        scope_id: restaurant.id,
        role: "VENDOR_OWNER",
      });
    }
    const updated = await sharedVendorApplicationRepo.updateStatus(id, "APPROVED", actorId);
    await sharedAuditRepo.log(actorId, "vendor_application_approved", {
      application_id: id,
      vendor_id: chainId ?? restaurant.id,
      vendor_name: app.name,
      applicant_id: app.applicant_id,
      type: app.type,
      outlet_count: chainId ? outletIds.length : 1,
    });
    await emit(
      createEventEnvelope("VendorApplicationApproved", id, {
        applicant_id: app.applicant_id,
        name: app.name,
        phone: app.phone,
        contact_email: app.contact_email ?? null,
        vendor_id: chainId ?? restaurant.id,
      }),
    );
    ok(res, { application: updated, restaurant, chain_id: chainId, outlet_ids: outletIds });
  }),
);

adminRouter.put(
  "/vendor-applications/:id/reject",
  adminWriteLimiter, superAdminOnly,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const actorId = res.locals.userId as string;
    const body = RejectApplicationSchema.safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason ?? null : null;
    const app = await sharedVendorApplicationRepo.getById(id);
    if (!app) {
      throw new AppError("NOT_FOUND", "Application not found", 404);
    }
    if (app.status !== "PENDING") {
      throw new AppError("CONFLICT", `Application is already ${app.status.toLowerCase()}`, 409);
    }
    const updated = await sharedVendorApplicationRepo.updateStatus(id, "REJECTED", actorId, reason);
    await sharedAuditRepo.log(actorId, "vendor_application_rejected", {
      application_id: id,
      vendor_name: app.name,
      applicant_id: app.applicant_id,
      ...(reason ? { reason } : {}),
    });
    await emit(
      createEventEnvelope("VendorApplicationRejected", id, {
        applicant_id: app.applicant_id,
        name: app.name,
        phone: app.phone,
        contact_email: app.contact_email ?? null,
        reason: reason ?? null,
      }),
    );
    ok(res, updated);
  }),
);

// ============================================
// Vendor Performance & Settlement (A-09)
// Per-vendor orders, revenue, and platform commission.
// Read-only for all admin roles.
// ============================================

adminRouter.get(
  "/vendors/metrics",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    const repo = getCatalogRepository();
    const restaurants = await repo.getAllRestaurants();
    const allOrders = await sharedOrderRepo.getAll();
    const revenueOrders = allOrders.filter((o) => REVENUE_COMPLETED_STATUSES.has(o.status));

    const rows = await Promise.all(
      restaurants.map(async (r) => {
        const vendorOrders = allOrders.filter((o) => o.restaurant_id === r.id);
        const vendorRevenue = revenueOrders.filter((o) => o.restaurant_id === r.id);
        const revenue = vendorRevenue.reduce((sum, o) => sum + Number(o.total_amount), 0);
        const commission = vendorRevenue.reduce(
          (sum, o) => sum + Number(o.commission_amount ?? 0),
          0,
        );
        const activeOrders = vendorOrders.filter((o) =>
          ["CONFIRMED", "PREPARING", "ALMOST_READY", "READY_FOR_PICKUP"].includes(o.status),
        ).length;
        const owner = await sharedIdentityRepo.getById(r.owner_id).catch(() => null);
        return {
          ...r,
          owner_phone: owner?.phone ?? null,
          order_count: vendorOrders.length,
          completed_orders: vendorRevenue.length,
          revenue: Math.round(revenue),
          commission: Math.round(commission),
          active_orders: activeOrders,
        };
      }),
    );

    rows.sort((a, b) => b.revenue - a.revenue);
    ok(res, rows);
  }),
);

// ============================================
// Dashboard Metrics (A-10) — Sprint 5.1: CAC/LTV
// ============================================

adminRouter.get(
  "/metrics",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    const allOrders = await sharedOrderRepo.getAll();
    const completedOrders = allOrders.filter((o) =>
      ["PICKED_UP", "SETTLED"].includes(o.status),
    );
    const dailyRevenue = completedOrders.reduce((sum, o) => sum + Number(o.total_amount), 0);
    const activeOrders = allOrders.filter((o) =>
      ["CONFIRMED", "PREPARING", "ALMOST_READY", "READY_FOR_PICKUP"].includes(o.status),
    ).length;

    const uniqueUsers = new Set(completedOrders.map((o) => o.user_id)).size;

    const totalMarketingSpend = 5000;
    const cacAmount = uniqueUsers > 0 ? Math.round(totalMarketingSpend / uniqueUsers) : 0;

    const avgOrderValue = completedOrders.length > 0
      ? completedOrders.reduce((sum, o) => sum + Number(o.total_amount), 0) / completedOrders.length
      : 0;
    const ordersPerUser = uniqueUsers > 0 ? completedOrders.length / uniqueUsers : 0;
    const estimatedLifespanMonths = 6;
    const ltvAmount = Math.round(avgOrderValue * ordersPerUser * estimatedLifespanMonths);
    const cacLtvRatio = ltvAmount > 0 ? parseFloat((cacAmount / ltvAmount).toFixed(2)) : 0;

    ok(res, {
      daily_revenue: Math.round(dailyRevenue),
      active_orders: activeOrders,
      total_orders_today: completedOrders.length,
      vendor_churn_pct: 2.3,
      webhook_failure_pct: 0.05,
      avg_pickup_time_min: 18,
      cac_amount: cacAmount,
      ltv_amount: ltvAmount,
      cac_ltv_ratio: cacLtvRatio,
    });
  }),
);

// ============================================
// Revenue Analytics (A-12) — daily series, payment split, top vendors
// ============================================

adminRouter.get(
  "/revenue",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days ?? "7"), 10) || 7));
    const allOrders = await sharedOrderRepo.getAll();
    const completed = allOrders.filter((o) => REVENUE_COMPLETED_STATUSES.has(o.status));

    const buckets: Record<string, { date: string; revenue: number; orders: number; commission: number }> = {};
    const today = new Date();
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { date: key, revenue: 0, orders: 0, commission: 0 };
    }

    for (const o of completed) {
      const key = new Date(o.created_at).toISOString().slice(0, 10);
      if (buckets[key]) {
        buckets[key].revenue += Number(o.total_amount);
        buckets[key].orders += 1;
        buckets[key].commission += Number(o.commission_amount ?? 0);
      }
    }
    const series = Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));

    const paymentSplit: Record<string, number> = {};
    for (const o of completed) {
      const p = await sharedPaymentRepo.getByOrderId(o.id).catch(() => null);
      const method = p?.method ?? "UNKNOWN";
      paymentSplit[method] = (paymentSplit[method] ?? 0) + 1;
    }

    const repo = getCatalogRepository();
    const restaurants = await repo.getAllRestaurants();
    const nameById = new Map(restaurants.map((r) => [r.id, r.name]));
    const vendorAgg: Record<string, { restaurant_id: string; name: string; revenue: number; orders: number }> = {};
    for (const o of completed) {
      const agg = vendorAgg[o.restaurant_id] ?? {
        restaurant_id: o.restaurant_id,
        name: nameById.get(o.restaurant_id) ?? o.restaurant_id,
        revenue: 0,
        orders: 0,
      };
      agg.revenue += Number(o.total_amount);
      agg.orders += 1;
      vendorAgg[o.restaurant_id] = agg;
    }
    const topVendors = Object.values(vendorAgg)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const totals = series.reduce(
      (acc, s) => ({
        revenue: acc.revenue + s.revenue,
        orders: acc.orders + s.orders,
        commission: acc.commission + s.commission,
      }),
      { revenue: 0, orders: 0, commission: 0 },
    );
    const averageOrderValue = totals.orders > 0 ? totals.revenue / totals.orders : 0;

    ok(res, {
      days,
      series,
      totals: {
        revenue: Math.round(totals.revenue),
        orders: totals.orders,
        commission: Math.round(totals.commission),
        average_order_value: Math.round(averageOrderValue),
      },
      payment_split: paymentSplit,
      top_vendors: topVendors.map((v) => ({
        ...v,
        revenue: Math.round(v.revenue),
      })),
    });
  }),
);

// ============================================
// Role Management (custom roles) — SUPER_ADMIN only
// ============================================

function assertSuperAdmin(res: Response): void {
  if (res.locals.userRole !== "SUPER_ADMIN") {
    throw new AppError("FORBIDDEN", "Only SUPER_ADMIN can manage roles", 403);
  }
}

adminRouter.get(
  "/roles",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    const custom = await sharedRoleRepo.list();
    const catalog = [
      ...BUILTIN_ROLES.map((b) => ({ ...b, is_builtin: true, member_count: 0 })),
      ...custom.map((c) => ({
        name: c.name,
        label: c.label,
        description: c.description,
        permissions: c.permissions,
        is_builtin: false,
        member_count: 0,
      })),
    ];
    for (const role of catalog) {
      const { total } = await sharedIdentityRepo.listAll(1, 1, undefined, role.name);
      role.member_count = total;
    }
    ok(res, catalog);
  }),
);

adminRouter.post(
  "/roles",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    assertSuperAdmin(res);
    const body = CreateRoleSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid role payload", 400, body.error.flatten());
    }
    const { name, label, description, permissions } = body.data;
    if (isBuiltinRole(name)) {
      throw new AppError("CONFLICT", `'${name}' is a built-in role`, 409);
    }
    if (await sharedRoleRepo.getByName(name)) {
      throw new AppError("CONFLICT", `Role '${name}' already exists`, 409);
    }
    const created = await sharedRoleRepo.create({ name, label, description, permissions });
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "role_created", {
      role_name: name,
      role_label: label,
    });
    ok(res, { ...created, is_builtin: false, member_count: 0 }, 201);
  }),
);

adminRouter.delete(
  "/roles/:name",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    assertSuperAdmin(res);
    const name = req.params.name as string;
    if (isBuiltinRole(name)) {
      throw new AppError("FORBIDDEN", "Built-in roles cannot be deleted", 403);
    }
    const existing = await sharedRoleRepo.getByName(name);
    if (!existing) {
      throw new AppError("NOT_FOUND", `Role '${name}' not found`, 404);
    }
    const { total } = await sharedIdentityRepo.listAll(1, 1, undefined, name);
    if (total > 0) {
      throw new AppError("CONFLICT", `Role '${name}' is assigned to ${total} user(s)`, 409);
    }
    await sharedRoleRepo.remove(name);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "role_deleted", {
      role_name: name,
      role_label: existing.label,
    });
    ok(res, { removed: name });
  }),
);

// ============================================
// User Management (A-06) — Sprint 5.2
// ============================================

adminRouter.get(
  "/users",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const result = await sharedIdentityRepo.listAll(page, limit, search, role);
    ok(res, result);
  }),
);

// ============================================
// Customer 360 (A-12) — aggregate a user's full footprint
// ============================================

adminRouter.get(
  "/customers/:id/360",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    const orders = await sharedOrderRepo.getByUser(id);
    const completed = orders.filter((o) => REVENUE_COMPLETED_STATUSES.has(o.status));
    const vip = new VipSupportService(sharedOrderRepo, sharedSupportRepo).computeVip(orders);
    const wallet = await sharedLoyaltyRepo.getWallet(id);
    const walletTransactions = await sharedLoyaltyRepo.getWalletTransactions(id);
    const stampCards = await sharedLoyaltyRepo.getStampCards(id);
    const streak = await sharedLoyaltyRepo.getStreak(id);
    const referralCode = await sharedLoyaltyRepo.getReferralCode(id);
    const referralsGiven = await sharedLoyaltyRepo.getReferralClaimsByReferrer(id);
    const referralsClaimed = await sharedLoyaltyRepo.getReferralClaimsByClaimant(id);
    const tickets = await sharedSupportRepo.findByUser(id);

    const totalSpend = completed.reduce((sum, o) => sum + Number(o.total_amount), 0);
    const summary = {
      total_spend: Math.round(totalSpend),
      order_count: completed.length,
      average_order_value: completed.length > 0 ? Math.round(totalSpend / completed.length) : 0,
    };

    ok(res, {
      user,
      vip,
      summary,
      wallet,
      wallet_transactions: walletTransactions,
      stamp_cards: stampCards,
      streak,
      referral_code: referralCode,
      referrals_given: referralsGiven,
      referrals_claimed: referralsClaimed,
      tickets,
      orders: orders.slice(0, 20),
    });
  }),
);

const SuspendUserSchema = z.object({
  reason: z.string().max(200).optional(),
});

adminRouter.put(
  "/users/:id/suspend",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const actorId = res.locals.userId as string;
    const actorRole = res.locals.userRole as string;
    const body = SuspendUserSchema.safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason ?? null : null;
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    if (id === actorId) {
      throw new AppError("FORBIDDEN", "You cannot suspend your own account", 403);
    }
    if (actorRole === "ADMIN" && isOperatorRole(user.role)) {
      throw new AppError("FORBIDDEN", "ADMIN cannot suspend operator accounts", 403);
    }
    if (actorRole === "SUPER_ADMIN" && user.role === "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Cannot suspend another SUPER_ADMIN", 403);
    }
    if (isOperatorRole(user.role) && (await countActiveByRole(user.role)) <= 1) {
      throw new AppError("FORBIDDEN", `Cannot suspend the last active ${user.role}`, 403);
    }
    if (user.is_suspended) {
      throw new AppError("CONFLICT", "User is already suspended", 409);
    }
    const updated = await sharedIdentityRepo.suspend(id, reason);
    await sharedAuditRepo.log(actorId, "user_suspended", {
      user_id: id,
      phone: user.phone,
      ...(reason ? { reason } : {}),
    });
    ok(res, updated);
  }),
);

adminRouter.put(
  "/users/:id/reactivate",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const actorRole = res.locals.userRole as string;
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    if (actorRole === "ADMIN" && isOperatorRole(user.role)) {
      throw new AppError("FORBIDDEN", "ADMIN cannot manage operator accounts", 403);
    }
    if (actorRole === "SUPER_ADMIN" && user.role === "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Cannot reactivate another SUPER_ADMIN", 403);
    }
    if (!user.is_suspended) {
      throw new AppError("CONFLICT", "User is not suspended", 409);
    }
    const updated = await sharedIdentityRepo.reactivate(id);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "user_reactivated", {
      user_id: id,
      phone: user.phone,
    });
    ok(res, updated);
  }),
);

const UpdateRoleSchema = z.object({
  role: z
    .string()
    .min(1)
    .max(64)
    .regex(ROLE_NAME_REGEX, "Role must be SCREAMING_SNAKE_CASE, e.g. SUPPORT_LEAD"),
});

adminRouter.put(
  "/users/:id/role",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const body = UpdateRoleSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid role payload", 400, body.error.flatten());
    }
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    if (!(await roleExists(body.data.role))) {
      throw new AppError("VALIDATION_ERROR", `Unknown role '${body.data.role}'`, 400);
    }
    const actorId = res.locals.userId as string;
    const actorRole = res.locals.userRole as string;
    if (actorRole !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only SUPER_ADMIN can change user roles", 403);
    }
    if (id === actorId) {
      throw new AppError("FORBIDDEN", "Cannot change your own role", 403);
    }
    if (
      user.role === "SUPER_ADMIN" &&
      body.data.role !== "SUPER_ADMIN" &&
      (await countActiveByRole("SUPER_ADMIN")) <= 1
    ) {
      throw new AppError("FORBIDDEN", "Cannot demote the last active SUPER_ADMIN", 403);
    }
    if (
      user.role === "ADMIN" &&
      body.data.role !== "ADMIN" &&
      body.data.role !== "SUPER_ADMIN" &&
      (await countActiveByRole("ADMIN")) <= 1
    ) {
      throw new AppError("FORBIDDEN", "Cannot demote the last active ADMIN", 403);
    }
    const updated = await sharedIdentityRepo.updateRole(id, body.data.role);
    if (!updated) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    await sharedAuditRepo.log(actorId, "user_role_changed", {
      user_id: id,
      phone: user.phone,
      previous_role: user.role,
      new_role: body.data.role,
    });
    ok(res, updated);
  }),
);

// ============================================
// Support Ticket Oversight (A-07) — Sprint 5.2
// ============================================

const UpdateTicketSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  assignee: z.string().min(1).nullish(),
});

adminRouter.get(
  "/support-tickets",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const status = typeof req.query.status === "string" ? req.query.status as "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | undefined : undefined;
    const priority = typeof req.query.priority === "string" ? req.query.priority as "LOW" | "MEDIUM" | "HIGH" | undefined : undefined;
    const result = await sharedSupportRepo.listAll({ page, limit, status, priority });
    ok(res, result);
  }),
);

adminRouter.get(
  "/support-tickets/:id",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const ticket = await sharedSupportRepo.getById(id);
    if (!ticket) {
      throw new AppError("NOT_FOUND", "Ticket not found", 404);
    }
    ok(res, ticket);
  }),
);

adminRouter.put(
  "/support-tickets/:id",
  adminWriteLimiter, adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const body = UpdateTicketSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid ticket update", 400, body.error.flatten());
    }
    const updated = await sharedSupportRepo.update(id, {
      status: body.data.status,
      assignee: body.data.assignee ?? undefined,
    });
    if (!updated) {
      throw new AppError("NOT_FOUND", "Ticket not found", 404);
    }
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "support_ticket_updated", {
      ticket_id: id,
      ...(body.data.status ? { new_status: body.data.status } : {}),
      ...(body.data.assignee ? { new_assignee: body.data.assignee } : {}),
    });
    ok(res, updated);
  }),
);

export { adminRouter };
