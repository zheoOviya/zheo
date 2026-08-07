import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { sharedAuditRepo, sharedOrderRepo, sharedSupportRepo } from "../repositories/shared";
import { VipSupportService } from "../services/vipSupport";

// ============================================
// L15 VIP Customer Support - /api/v1/support
// Support bounded context. VIP = orders > 50 OR spend > Rs 5000.
// VIP tickets get HIGH priority + a specialized OPS_AGENT assignee.
// ============================================

const TicketSchema = z.object({
  subject: z.string().min(3, "subject is required").max(120),
  description: z.string().min(1, "description is required").max(2000),
});

const vipSupportService = new VipSupportService(
  sharedOrderRepo,
  sharedSupportRepo,
);

export const supportRouter: Router = Router();

supportRouter.get(
  "/vip-status",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }
    const status = await vipSupportService.getVipStatus(userId);
    ok(res, status);
  }),
);

supportRouter.post(
  "/ticket",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = TicketSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid ticket payload",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "User identity missing from token", 401);
    }

    const ticket = await vipSupportService.createTicket(
      userId,
      body.data.subject,
      body.data.description,
    );

    await sharedAuditRepo.log(userId, "support_ticket_created", {
      ticket_id: ticket.id,
      priority: ticket.priority,
      assignee: ticket.assignee,
      is_vip: ticket.is_vip,
    });

    ok(
      res,
      {
        id: ticket.id,
        subject: ticket.subject,
        priority: ticket.priority,
        assignee: ticket.assignee,
        is_vip: ticket.is_vip,
        created_at: ticket.created_at,
      },
      201,
    );
  }),
);
