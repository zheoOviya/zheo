import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { adminReadOnly } from "../middleware/requireRoles";
import { adminDineInReadService } from "../services/adminDineInReadService";

// ============================================================
// Admin Dine-In read-only surface (ADMIN-OPS1-A2).
//
// Mounted at /api/v1/admin/dine-in (NOT under /api/vendor). Every endpoint is
// gated per-route with the existing adminReadOnly middleware (ADMIN,
// SUPER_ADMIN, OPS_AGENT). Read-only composition only — no request bodies, no
// mutation, no payment/settlement/close surface.
//
//   GET /overview
//   GET /sessions
//   GET /sessions/:sessionId
// ============================================================

const adminDineInRouter: Router = Router();

const DineInSessionIdSchema = z.string().uuid("sessionId must be a valid uuid");

const AdminDineInSessionsQuerySchema = z.object({
  restaurant_id: z.string().uuid("restaurant_id must be a valid uuid").optional(),
  status: z
    .enum(["OPEN", "ACTIVE", "BILL_REQUESTED", "PAYMENT_PENDING"])
    .optional(),
  zone_id: z.string().uuid("zone_id must be a valid uuid").optional(),
  sort: z.enum(["opened_at", "updated_at", "table_label"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function invalidQuery(error: z.ZodError): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    "Invalid query parameters",
    400,
    error.flatten(),
  );
}

adminDineInRouter.get(
  "/overview",
  adminReadOnly,
  asyncHandler(async (_req, res) => {
    ok(res, await adminDineInReadService.getOverview());
  }),
);

adminDineInRouter.get(
  "/sessions",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const parsed = AdminDineInSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw invalidQuery(parsed.error);
    const query = parsed.data;
    ok(
      res,
      await adminDineInReadService.listSessions({
        restaurant_id: query.restaurant_id,
        status: query.status,
        zone_id: query.zone_id,
        sort: query.sort,
        order: query.order,
        page: query.page,
        limit: query.limit,
      }),
    );
  }),
);

adminDineInRouter.get(
  "/sessions/:sessionId",
  adminReadOnly,
  asyncHandler(async (req, res) => {
    const sessionId = DineInSessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid session id",
        400,
        sessionId.error.flatten(),
      );
    }
    ok(res, await adminDineInReadService.getSessionDetail(sessionId.data));
  }),
);

export { adminDineInRouter };
