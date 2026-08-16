import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { requireConsumerOrAdmin } from "../middleware/requireRoles";
import { sharedIdentityRepo } from "../repositories/shared";
import { createEventEnvelope, emit } from "../lib/eventBus";
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
    const updated = await sharedIdentityRepo.updateSpiceTolerance(
      userId,
      body.data.spice_tolerance,
    );
    if (!updated) {
      throw new AppError("USER_NOT_FOUND", "User profile not found", 404);
    }

    await emit(
      createEventEnvelope("SpiceProfileUpdated", userId, {
        user_id: userId,
        spice_tolerance: body.data.spice_tolerance,
      }),
    );

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
