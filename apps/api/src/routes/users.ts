import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { requireConsumerOrAdmin } from "../middleware/requireRoles";
import { sharedIdentityRepo } from "../repositories/shared";
import { getSpiceProfileTransactionPort } from "../repositories/drizzle/producerRemainingTransactionPort";
import { createEventEnvelope } from "../lib/eventBus";
import { logger } from "../lib/logger";

// ============================================
// Identity context routes - /api/v1/users
// D03 Spice Tolerance Profile: 1 (mild) to 5 (extreme).
// Menu fetches downstream filter out items above this level.
// ============================================

const UpdateProfileSchema = z.object({
  spice_tolerance: z.number().int().min(1).max(5, "spice_tolerance is 1-5"),
});

export const usersRouter: Router = Router();

usersRouter.put(
  "/users/profile",
  requireConsumerOrAdmin,
  asyncHandler(async (req, res) => {
    const body = UpdateProfileSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "spice_tolerance must be an integer between 1 and 5",
        400,
        body.error.flatten(),
      );
    }

    const userId = res.locals.userId as string;
    // The spice-tolerance write and its SpiceProfileUpdated row share ONE
    // transaction (EVT-B2B-NP2), so a missing user enqueues nothing and a
    // rollback cannot publish a profile change that was not committed.
    const updated = await getSpiceProfileTransactionPort(
      sharedIdentityRepo,
    ).runInTransaction(async ({ identity, outbox }) => {
      const row = await identity.updateSpiceTolerance(
        userId,
        body.data.spice_tolerance,
      );
      if (!row) return null;
      await outbox.enqueue(
        createEventEnvelope("SpiceProfileUpdated", userId, {
          user_id: userId,
          spice_tolerance: body.data.spice_tolerance,
        }),
      );
      return row;
    });
    if (!updated) {
      throw new AppError("USER_NOT_FOUND", "User profile not found", 404);
    }

    logger.info({
      message: "spice_profile_updated",
      user_id: userId,
      spice_tolerance: body.data.spice_tolerance,
    });

    ok(res, {
      user_id: userId,
      phone: updated.phone,
      spice_tolerance: updated.spice_tolerance ?? null,
    });
  }),
);

export const profileRouter = usersRouter;
