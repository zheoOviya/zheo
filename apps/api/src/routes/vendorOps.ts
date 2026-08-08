import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { assertRestaurantAccess } from "../middleware/vendorAccess";
import { getCatalogRepository } from "./catalog";
import {
  sharedAuditRepo,
  sharedIdentityRepo,
  sharedOrderRepo,
  sharedPosOrderRepo,
  sharedPromotionRepo,
} from "../repositories/shared";
import {
  ALLOWED_IMAGE_MIME,
  buildMenuPhotoKey,
  createImageStorage,
  type ImageStorage,
} from "../services/imageStorage";
import {
  buildSettlementSummary,
  generateDailySettlement,
  previousSettlementWindow,
} from "../services/settlement";
import { InsightsService, parseInsightsDays } from "../services/insights";
import {
  MenuSyncService,
  MockPosMenuClient,
} from "../services/menuSync";
import { PetpoojaPosService } from "../services/posPetpooja";
import {
  buildGstCsv,
  gstMonthWindow,
  parseGstMonth,
} from "../services/gstExport";
import {
  MenuBulkUpdateError,
} from "../repositories/catalogRepository";
import { logger } from "../lib/logger";

// ============================================
// Vendor Ops context routes - /api/vendor
// V11 Daily Settlement Reports (PDF + JSON)
// V13 Menu Photo Upload
// EOS Layer 2 Audit Trail
// ============================================

// In production the actor is the authenticated JWT sub. The vendor routes
// currently mirror the existing /api/vendor/* pattern (no auth gate), so we
// fall back to a deterministic system actor for the audit trail.
const SYS_ACTOR_ID = "00000000-0000-4000-8000-0000000000a7";

function actorId(res: { locals: Record<string, unknown> }): string {
  const userId = res.locals.userId;
  return typeof userId === "string" && userId.length > 0 ? userId : SYS_ACTOR_ID;
}

function restaurantIdOf(req: {
  query: Record<string, unknown>;
}): string {
  const value = req.query.restaurant_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "restaurant_id query param required",
      400,
    );
  }
  return value;
}

function paramId(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const MenuItemPatchSchema = z
  .object({
    price: z.number().positive("price must be positive").max(100000).optional(),
    is_available: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine((d) => d.price !== undefined || d.is_available !== undefined || d.description !== undefined, {
    message: "At least one of price / is_available / description is required",
  });

const BulkItemPatchSchema = z
  .object({
    item_id: z.string().uuid("item_id must be a valid uuid"),
    price: z.number().positive("price must be positive").max(100000).optional(),
    is_available: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine(
    (d) =>
      d.price !== undefined ||
      d.is_available !== undefined ||
      d.description !== undefined,
    { message: "At least one editable field is required per row" },
  );

const BulkMenuUpdateSchema = z.object({
  items: z.array(BulkItemPatchSchema).min(1).max(200),
});

const PromotionCreateSchema = z
  .object({
    title: z.string().min(1, "title is required").max(120),
    discount_type: z.enum(["FLAT", "PERCENTAGE"]),
    value: z.number().positive("value must be positive"),
    valid_until: z
      .string()
      .refine((d) => !Number.isNaN(Date.parse(d)), {
        message: "valid_until must be a valid date",
      }),
  })
  .superRefine((d, ctx) => {
    if (d.discount_type === "PERCENTAGE" && d.value > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "PERCENTAGE value must be <= 100",
      });
    }
    if (d.discount_type === "FLAT" && d.value > 100000) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "FLAT value must be <= 100000",
      });
    }
  });

export const vendorOpsRouter: Router = Router();

// Shared POS integration services (same repos as the webhook route).
const menuSyncService = new MenuSyncService(
  getCatalogRepository(),
  new MockPosMenuClient(),
);
const insightsService = new InsightsService(sharedOrderRepo);
const petpoojaPosService = new PetpoojaPosService(
  sharedOrderRepo,
  getCatalogRepository(),
  sharedIdentityRepo,
  sharedPosOrderRepo,
);

// ---- V13: Menu Management -------------------------------------------------

vendorOpsRouter.get(
  "/menu",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const repo = getCatalogRepository();
    const items = await repo.getMenuAll(restaurantId);
    ok(res, items.map((m) => ({
      id: m.id,
      name: m.name,
      price: m.price,
      description: m.description,
      dietary_tags: m.dietary_tags,
      image_url: m.image_url,
      is_available: m.is_available,
    })));
  }),
);

// ---- V14: Bulk Menu Edit ---------------------------------------------------
// Registered BEFORE /menu/:itemId so "bulk" is never captured as an :itemId.

vendorOpsRouter.put(
  "/menu/bulk",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const body = BulkMenuUpdateSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid bulk menu payload",
        400,
        body.error.flatten(),
      );
    }

    const repo = getCatalogRepository();
    let updated;
    try {
      updated = await repo.bulkUpdateMenuItems(restaurantId, body.data.items);
    } catch (err) {
      if (err instanceof MenuBulkUpdateError) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Menu item ${err.itemId} not found or not owned by this restaurant`,
          400,
        );
      }
      throw err;
    }

    await sharedAuditRepo.log(actorId(res), "menu_bulk_updated", {
      restaurant_id: restaurantId,
      item_count: updated.length,
      item_ids: body.data.items.map((i) => i.item_id),
    });

    ok(res, updated);
  }),
);

vendorOpsRouter.put(
  "/menu/:itemId",
  asyncHandler(async (req, res) => {
    const patch = MenuItemPatchSchema.safeParse(req.body);
    if (!patch.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid menu item patch",
        400,
        patch.error.flatten(),
      );
    }
    const repo = getCatalogRepository();
    const item = await repo.getMenuItemById(paramId(req.params.itemId));
    if (!item) {
      throw new AppError("NOT_FOUND", "Menu item not found", 404);
    }
    await assertRestaurantAccess(res, item.restaurant_id);
    const updated = await repo.updateMenuItem(paramId(req.params.itemId), patch.data);
    await sharedAuditRepo.log(actorId(res), "menu_updated", {
      menu_item_id: paramId(req.params.itemId),
      restaurant_id: item.restaurant_id,
      ...patch.data,
    });
    ok(res, updated);
  }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const imageStorage: ImageStorage = createImageStorage();

vendorOpsRouter.post(
  "/menu/:itemId/upload-photo",
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new AppError(
        "VALIDATION_ERROR",
        "photo file is required (multipart field 'photo')",
        400,
      );
    }
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Unsupported image type: ${file.mimetype}. Allowed: jpeg, png, webp, gif`,
        400,
      );
    }
    const repo = getCatalogRepository();
    const item = await repo.getMenuItemById(paramId(req.params.itemId));
    if (!item) {
      throw new AppError("NOT_FOUND", "Menu item not found", 404);
    }
    await assertRestaurantAccess(res, item.restaurant_id);

    const ext = file.originalname.split(".").pop() ?? "jpg";
    const key = buildMenuPhotoKey(item.restaurant_id, item.id, ext);
    const imageUrl = await imageStorage.upload(file.buffer, file.mimetype, key);

    const updated = await repo.updateImageUrl(item.id, imageUrl);
    await sharedAuditRepo.log(actorId(res), "menu_photo_uploaded", {
      menu_item_id: item.id,
      restaurant_id: item.restaurant_id,
      image_url: imageUrl,
      content_type: file.mimetype,
      size_bytes: file.size,
    });
    logger.info({
      message: "menu_photo_uploaded",
      menu_item_id: item.id,
      image_url: imageUrl,
    });
    ok(res, { id: updated?.id, image_url: imageUrl });
  }),
);

// ---- V11: Daily Settlements ------------------------------------------------

vendorOpsRouter.get(
  "/settlements/summary",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const { periodStart, periodEnd } = previousSettlementWindow();
    const orders = await sharedOrderRepo.getSettlableOrdersByRestaurant(
      restaurantId,
      periodStart,
      periodEnd,
    );
    const summary = buildSettlementSummary(orders, periodStart, periodEnd);
    ok(res, summary);
  }),
);

vendorOpsRouter.put(
  "/settlements/today",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const restaurant = await getCatalogRepository().getRestaurantById(
      restaurantId,
    );
    const restaurantName = restaurant?.name ?? restaurantId;
    const { summary, pdf } = await generateDailySettlement(
      sharedOrderRepo,
      restaurantId,
      restaurantName,
    );

    await sharedAuditRepo.log(actorId(res), "settlement_downloaded", {
      restaurant_id: restaurantId,
      period: summary.period_start.slice(0, 10),
      order_count: summary.order_count,
      net_payout: summary.net_payout,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="settlement-${summary.period_start.slice(0, 10)}.pdf"`,
    );
    res.send(pdf);
  }),
);

// ---- V01: Petpooja POS Integration ----------------------------------------

vendorOpsRouter.post(
  "/pos/sync-menu",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const result = await menuSyncService.syncMenu(restaurantId);

    await sharedAuditRepo.log(actorId(res), "pos_menu_synced", {
      restaurant_id: restaurantId,
      synced_count: result.synced,
    });

    ok(res, { synced: result.synced });
  }),
);

vendorOpsRouter.post(
  "/pos/simulate-order",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);

    // One-click demo: sync first so the POS items exist, then push an order.
    const synced = await menuSyncService.syncMenu(restaurantId);

    const payload = {
      pos_order_id: `pos_${randomUUID().slice(0, 12)}`,
      restaurant_id: restaurantId,
      customer_phone: `91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      ordered_at: new Date().toISOString(),
      items: [
        { pos_item_id: "pp-3001", name: "Mutton Biryani", quantity: 2, price: 260, customizations: [] },
        { pos_item_id: "pp-4001", name: "Gobi Manchurian", quantity: 1, price: 150, customizations: [] },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;

    const result = await petpoojaPosService.processOrderWebhook(
      rawBody,
      signature,
    );

    await sharedAuditRepo.log(actorId(res), "pos_order_simulated", {
      restaurant_id: restaurantId,
      pos_order_id: payload.pos_order_id,
      order_id: result.order_id,
    });

    ok(res, { menu_synced: synced.synced, import: result });
  }),
);

// ---- V08: Customer Insights ------------------------------------------------

vendorOpsRouter.get(
  "/insights",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const days = parseInsightsDays(req.query.days);
    const insights = await insightsService.compute(restaurantId, days);
    ok(res, insights);
  }),
);

// ---- V09: Promotions Builder ------------------------------------------------

vendorOpsRouter.post(
  "/promotions",
  asyncHandler(async (req, res) => {
    const body = PromotionCreateSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid promotion payload",
        400,
        body.error.flatten(),
      );
    }

    const promotion = await sharedPromotionRepo.create({
      title: body.data.title,
      discount_type: body.data.discount_type,
      value: body.data.value,
      valid_until: new Date(body.data.valid_until).toISOString(),
    });

    await sharedAuditRepo.log(actorId(res), "promotion_created", {
      promotion_id: promotion.id,
      title: promotion.title,
      discount_type: promotion.discount_type,
      value: promotion.value,
      valid_until: promotion.valid_until,
    });

    ok(res, promotion, 201);
  }),
);

vendorOpsRouter.get(
  "/promotions",
  asyncHandler(async (_req, res) => {
    const promotions = await sharedPromotionRepo.listActive();
    ok(res, promotions);
  }),
);

// ---- V12: GST Compliance Export --------------------------------------------

vendorOpsRouter.get(
  "/gst-export",
  asyncHandler(async (req, res) => {
    const restaurantId = restaurantIdOf(req);
    await assertRestaurantAccess(res, restaurantId);
    const month = parseGstMonth(req.query.month);
    const { startIso, endIso } = gstMonthWindow(month);

    const orders = await sharedOrderRepo.getSettlableOrdersByRestaurant(
      restaurantId,
      startIso,
      endIso,
    );

    const restaurant = await getCatalogRepository().getRestaurantById(
      restaurantId,
    );
    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Restaurant not found", 404);
    }

    const csv = buildGstCsv(orders, restaurant, month);

    await sharedAuditRepo.log(actorId(res), "gst_export_downloaded", {
      restaurant_id: restaurantId,
      month,
      order_count: orders.length,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gstr1-${month}.csv"`,
    );
    res.send(csv);
  }),
);
