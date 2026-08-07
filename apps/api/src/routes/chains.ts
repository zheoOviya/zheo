import { Router } from "express";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { requireRole } from "../middleware/requireRoles";
import { getCatalogRepository } from "./catalog";
import { sharedAuditRepo, sharedChainRepo, sharedOrderRepo } from "../repositories/shared";
import { AggregateInsightsService } from "../services/aggregateInsights";

// ============================================
// V15 Multi-Outlet Dashboard - /api/vendor/chains
// Strict RBAC: only VENDOR_OWNER or ADMIN roles may read chain-level data.
// Ownership: a VENDOR_OWNER only sees chains they own; ADMIN bypasses.
// A standard VENDOR_STAFF gets 403 Forbidden.
// ============================================

const aggregateInsightsService = new AggregateInsightsService(
  sharedOrderRepo,
  sharedChainRepo,
  getCatalogRepository(),
);

export const chainsRouter: Router = Router();

function actorId(res: { locals: Record<string, unknown> }): string {
  const userId = res.locals.userId;
  return typeof userId === "string" && userId.length > 0 ? userId : "";
}

chainsRouter.get(
  "/chains",
  requireRole("VENDOR_OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const userId = actorId(res);
    const role = String(res.locals.userRole ?? "");
    const chains =
      role === "ADMIN" || role === "SUPER_ADMIN"
        ? await sharedChainRepo.getAll()
        : await sharedChainRepo.getByOwner(userId);

    const catalog = getCatalogRepository();
    const result = [];
    for (const chain of chains) {
      const outletIds = await sharedChainRepo.getOutletIdsByChain(chain.id);
      const outlets = [];
      for (const restaurantId of outletIds) {
        const restaurant = await catalog.getRestaurantById(restaurantId);
        outlets.push({
          restaurant_id: restaurantId,
          name: restaurant?.name ?? restaurantId,
        });
      }
      result.push({ id: chain.id, name: chain.name, outlets });
    }

    await sharedAuditRepo.log(userId, "chains_listed", {
      chain_count: result.length,
    });

    ok(res, result);
  }),
);

chainsRouter.get(
  "/chains/:chainId/aggregate-insights",
  requireRole("VENDOR_OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const chainId =
      typeof req.params.chainId === "string" ? req.params.chainId : "";
    const userId = actorId(res);
    const role = String(res.locals.userRole ?? "");

    const chain = await sharedChainRepo.getById(chainId);
    if (!chain) {
      throw new AppError("CHAIN_NOT_FOUND", "Chain not found", 404);
    }

    // Ownership guard: only the Chain Owner (or an admin) may read a chain.
    if (role !== "ADMIN" && role !== "SUPER_ADMIN" && chain.owner_id !== userId) {
      throw new AppError(
        "FORBIDDEN",
        "You do not own this chain",
        403,
      );
    }

    const insights = await aggregateInsightsService.computeForChain(chainId);

    await sharedAuditRepo.log(userId, "chain_aggregate_insights", {
      chain_id: chainId,
      outlet_count: insights.outlet_count,
      total_orders: insights.total_orders,
      total_revenue: insights.total_revenue,
    });

    ok(res, insights);
  }),
);
