import { Router } from "express";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { getCatalogRepository } from "./catalog";
import {
  sharedAuditRepo,
  sharedIdentityRepo,
  sharedOrderRepo,
  sharedPosOrderRepo,
} from "../repositories/shared";
import { PetpoojaPosService } from "../services/posPetpooja";

// ============================================
// POS webhook routes - /api/v1/webhooks/pos
// Petpooja order push (PRD Phase 2, V01).
//
// The signature is verified over the exact inbound bytes captured by the
// JSON parser (req.rawBody), so HMAC covers the original payload — not a
// re-serialization that could silently change bytes and break the MAC.
// ============================================

const petpoojaPosService = new PetpoojaPosService(
  sharedOrderRepo,
  getCatalogRepository(),
  sharedIdentityRepo,
  sharedPosOrderRepo,
);

export const posWebhookRouter: Router = Router();

posWebhookRouter.post(
  "/petpooja",
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-petpooja-signature"] as
      | string
      | undefined;
    if (!signature) {
      throw new AppError(
        "MISSING_SIGNATURE",
        "X-Petpooja-Signature header is required",
        401,
      );
    }

    const rawBody =
      typeof req.rawBody === "string"
        ? req.rawBody
        : req.rawBody?.toString("utf8") ?? JSON.stringify(req.body);
    const result = await petpoojaPosService.processOrderWebhook(
      rawBody,
      signature,
    );

    // Audit every inbound POS order, including idempotent replays.
    if (result.order_id) {
      await sharedAuditRepo.log(
        "00000000-0000-4000-8000-0000000000a7",
        "pos_order_received",
        {
          pos_order_id: (req.body as { pos_order_id?: string })?.pos_order_id,
          order_id: result.order_id,
          idempotent: result.idempotent,
        },
      );
    }

    ok(res, result);
  }),
);

export { petpoojaPosService };
