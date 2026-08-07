import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { adminReadOnly, adminWrite } from "../middleware/requireRoles";
import {
  sharedAuditRepo,
  sharedOrderRepo,
  sharedIdentityRepo,
  sharedKillSwitchRepo,
  sharedSupportRepo,
} from "../repositories/shared";
import { getCatalogRepository } from "./catalog";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import type { KillSwitchDTO } from "../repositories/killSwitchRepository";

const adminRouter: Router = Router();

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
  adminWrite,
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
    ok(res, order);
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
  adminWrite,
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
  adminWrite,
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
  adminWrite,
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
  adminWrite,
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
// User Management (A-06) — Sprint 5.2
// ============================================

adminRouter.get(
  "/users",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const result = await sharedIdentityRepo.listAll(page, limit, search);
    ok(res, result);
  }),
);

adminRouter.put(
  "/users/:id/suspend",
  adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    if (user.is_suspended) {
      throw new AppError("CONFLICT", "User is already suspended", 409);
    }
    const updated = await sharedIdentityRepo.suspend(id);
    const actorId = res.locals.userId as string;
    await sharedAuditRepo.log(actorId, "user_suspended", {
      user_id: id,
      phone: user.phone,
    });
    ok(res, updated);
  }),
);

adminRouter.put(
  "/users/:id/reactivate",
  adminWrite,
  asyncHandler(async (req, res) => {
    const id = req.params.id as string;
    const user = await sharedIdentityRepo.getById(id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User not found", 404);
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

const ALL_ROLES = ["CONSUMER", "VENDOR_OWNER", "VENDOR_STAFF", "OPS_AGENT", "ADMIN", "SUPER_ADMIN"] as const;
const UpdateRoleSchema = z.object({
  role: z.enum(ALL_ROLES),
});

adminRouter.put(
  "/users/:id/role",
  adminWrite,
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
    const actorId = res.locals.userId as string;
    const actorRole = res.locals.userRole as string;
    if (actorRole !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Only SUPER_ADMIN can change user roles", 403);
    }
    if (id === actorId) {
      throw new AppError("FORBIDDEN", "Cannot change your own role", 403);
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
  adminWrite,
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
