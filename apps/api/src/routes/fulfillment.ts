import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { sharedAuditRepo, sharedOrderRepo } from "../repositories/shared";
import { FulfillmentService } from "../services/fulfillment";
import { GeoFenceService } from "../services/geoFence";

// ============================================
// Fulfillment context routes
// Consumer: check-in, confirm-pickup
// Vendor: advance order status
// ============================================

const ConfirmPickupSchema = z.object({
  qr_token: z.string().uuid().optional(),
  pickup_otp: z.string().length(4).optional(),
}).refine((d) => d.qr_token || d.pickup_otp, {
  message: "Either qr_token or pickup_otp is required",
});

const LocationUpdateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const fulfillmentService = new FulfillmentService(sharedOrderRepo);
const geoFenceService = new GeoFenceService(sharedOrderRepo);

function orderId(id: string | string[] | undefined): string {
  if (Array.isArray(id)) return id[0] ?? "";
  return id ?? "";
}

export const fulfillmentRouter: Router = Router();

// Consumer check-in (requires auth)
fulfillmentRouter.post(
  "/orders/:id/check-in",
  authenticate,
  asyncHandler(async (req, res) => {
    const order = await fulfillmentService.checkIn(orderId(req.params.id));
    ok(res, { checked_in: order.checked_in, status: order.status });
  }),
);

// P02 Geo-fence Detection: consumer reports live location.
// Within 100m + READY_FOR_PICKUP => auto check-in + UserArrivedAtRestaurant.
fulfillmentRouter.post(
  "/orders/:id/location-update",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = LocationUpdateSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "lat/lng required", 400, body.error.flatten());
    }
    const result = await geoFenceService.handleLocationUpdate(
      orderId(req.params.id),
      body.data,
    );
    ok(res, result);
  }),
);

// Consumer confirm-pickup (QR or OTP). Requires authentication.
fulfillmentRouter.post(
  "/orders/:id/confirm-pickup",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = ConfirmPickupSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request", 400, body.error.flatten());
    }

    const order = await fulfillmentService.confirmPickup(
      orderId(req.params.id),
      body.data.qr_token,
      body.data.pickup_otp,
    );

    ok(res, { status: order.status, picked_up: true });
  }),
);

// Vendor status advancement (requires staff auth in production)
export const vendorRouter: Router = Router();

vendorRouter.put(
  "/orders/:id/status",
  asyncHandler(async (req, res) => {
    const result = await fulfillmentService.advanceOrderStatus(orderId(req.params.id));

    // P13: audit the early-ready alert so the push/SMS producer has a trail.
    if (result.earlyReadyAlerted) {
      await sharedAuditRepo.log("00000000-0000-4000-8000-0000000000a7", "early_ready_alerted", {
        order_id: result.order.id,
        restaurant_id: result.order.restaurant_id,
        scheduled_pickup_time: result.order.scheduled_pickup_time ?? null,
      });
    }

    ok(res, {
      order_id: result.order.id,
      status: result.nextStatus,
      pickup_otp: result.order.pickup_otp,
      qr_token: result.order.qr_token,
      early_ready_alerted: result.earlyReadyAlerted,
    });
  }),
);

vendorRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const restaurantId = req.query.restaurant_id as string | undefined;
    if (!restaurantId) {
      throw new AppError("VALIDATION_ERROR", "restaurant_id query param required", 400);
    }
    const orders = await sharedOrderRepo.getByRestaurant(restaurantId);
    const filtered = orders.filter(
      (o) => !["PICKED_UP", "CANCELLED", "PAYMENT_FAILED", "DRAFT", "PAYMENT_PENDING"].includes(o.status),
    );
    ok(res, filtered.map((o) => ({
      id: o.id,
      status: o.status,
      total_amount: o.total_amount,
      items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      pickup_otp: o.pickup_otp,
      qr_token: o.qr_token,
      checked_in: o.checked_in,
      created_at: o.created_at,
    })));
  }),
);
