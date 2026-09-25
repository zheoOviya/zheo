import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { assertRestaurantAccess } from "../middleware/vendorAccess";
import { rateLimiter } from "../middleware/rateLimiter";
import {
  sharedAuditRepo,
  sharedOrderRepo,
  sharedPaymentRepo,
  sharedIdentityRepo,
  sharedGiftRepo,
} from "../repositories/shared";
import { FulfillmentService } from "../services/fulfillment";
import { GeoFenceService } from "../services/geoFence";

// ============================================
// Fulfillment context routes
// Consumer: check-in, location-update
// Vendor: advance status, confirm-pickup
// ============================================

const ConfirmPickupSchema = z.object({
  pickup_otp: z.string().length(4),
});

const LocationUpdateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const fulfillmentService = new FulfillmentService(sharedOrderRepo, sharedGiftRepo);
const geoFenceService = new GeoFenceService(sharedOrderRepo);

function orderId(id: string | string[] | undefined): string {
  if (Array.isArray(id)) return id[0] ?? "";
  return id ?? "";
}

// Pickup OTP is 4 digits, so it must be defended against brute-force.
// Fail-closed per order+IP: 10 attempts per minute. Exceeding the window
// yields 429 (or 503 if Redis is down).
const pickupLimiter = rateLimiter({
  prefix: "pickup",
  max: 10,
  windowMs: 60_000,
  identifier: (req) => {
    const id = orderId(req.params.id);
    return id ? `${id}|${req.ip ?? "unknown"}` : (req.ip ?? "unknown");
  },
  failClosed: true,
});

export const fulfillmentRouter: Router = Router();

// Consumer check-in (requires auth + order ownership).
// The ownership guard lives at the route boundary (HTTP authorization is not a
// service concern) and mirrors GET /orders/:id: 404 when missing, 403 FORBIDDEN
// when the order belongs to another user.
fulfillmentRouter.post(
  "/orders/:id/check-in",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = orderId(req.params.id);
    const existing = await sharedOrderRepo.getById(id);
    if (!existing) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    if (existing.user_id !== res.locals.userId) {
      throw new AppError("FORBIDDEN", "You do not have access to this order", 403);
    }
    const order = await fulfillmentService.checkIn(id);
    ok(res, { checked_in: order.checked_in, status: order.status });
  }),
);

// P02 Geo-fence Detection: consumer reports live location.
// Within 100m + READY_FOR_PICKUP => auto check-in + UserArrivedAtRestaurant.
// Owner-only: a foreign caller must never be able to trigger distance
// evaluation, auto-check-in, or an arrival event for another user's order.
// The guard stays at the route boundary (caller identity is an HTTP concern).
fulfillmentRouter.post(
  "/orders/:id/location-update",
  authenticate,
  asyncHandler(async (req, res) => {
    const id = orderId(req.params.id);
    const existing = await sharedOrderRepo.getById(id);
    if (!existing) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    if (existing.user_id !== res.locals.userId) {
      throw new AppError("FORBIDDEN", "You do not have access to this order", 403);
    }
    const body = LocationUpdateSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "lat/lng required", 400, body.error.flatten());
    }
    const result = await geoFenceService.handleLocationUpdate(id, body.data);
    ok(res, result);
  }),
);

// Vendor/staff pickup handover (OTP). F2 actor separation: pickup
// completion is a restaurant action, so it is a vendor route behind the
// vendor/admin role gate and requires access to the order's restaurant. The
// customer still presents the credential; staff enter it. The 4-digit OTP
// space is defended by the fail-closed per-order pickup rate limiter.

// Vendor status advancement (requires staff auth in production)
export const vendorRouter: Router = Router();

vendorRouter.put(
  "/orders/:id/status",
  asyncHandler(async (req, res) => {
    const order = await sharedOrderRepo.getById(orderId(req.params.id));
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    await assertRestaurantAccess(res, order.restaurant_id);

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
      early_ready_alerted: result.earlyReadyAlerted,
    });
  }),
);

// Vendor/staff pickup handover. Order access is authorized BEFORE the pickup
// rate limiter: an unauthorized caller must not be able to consume the target
// order's pickup quota before being denied. Effective sequence: load order ->
// 404 if missing -> assertRestaurantAccess -> pickupLimiter -> schema -> mutate.
const requirePickupOrderAccess = asyncHandler(async (req, res, next) => {
  const id = orderId(req.params.id);
  const existing = await sharedOrderRepo.getById(id);
  if (!existing) {
    throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
  }
  await assertRestaurantAccess(res, existing.restaurant_id);
  next();
});

vendorRouter.post(
  "/orders/:id/confirm-pickup",
  requirePickupOrderAccess,
  pickupLimiter,
  asyncHandler(async (req, res) => {
    const body = ConfirmPickupSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request", 400, body.error.flatten());
    }

    const order = await fulfillmentService.confirmPickup(
      orderId(req.params.id),
      body.data.pickup_otp,
    );

    ok(res, { status: order.status, picked_up: true });
  }),
);

const VendorOrdersQuerySchema = z.object({
  restaurant_id: z.string().uuid(),
  // "active" = live kitchen pipeline (default, excludes terminal/not-yet-paid
  // states). "all" = full history for the Orders console.
  scope: z.enum(["active", "all"]).default("active"),
  // Optional single-status filter on top of scope (e.g. status=READY_FOR_PICKUP).
  status: z.string().optional(),
});

// States that never belong in the live kitchen pipeline.
const INACTIVE_STATUSES = [
  "DRAFT",
  "PAYMENT_PENDING",
  "PICKED_UP",
  "CANCELLED",
  "REFUNDED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "DISPUTED",
  "SETTLED",
] as const;

vendorRouter.put(
  "/orders/:id/cancel",
  asyncHandler(async (req, res) => {
    const order = await sharedOrderRepo.getById(orderId(req.params.id));
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }
    await assertRestaurantAccess(res, order.restaurant_id);

    const updated = await fulfillmentService.cancelOrder(order.id);
    ok(res, { order_id: updated.id, status: updated.status });
  }),
);

vendorRouter.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const query = VendorOrdersQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Invalid query parameters",
        400,
        query.error.flatten(),
      );
    }
    const { restaurant_id, scope, status } = query.data;
    await assertRestaurantAccess(res, restaurant_id);

    const orders = await sharedOrderRepo.getByRestaurant(restaurant_id);
    const filtered =
      scope === "all"
        ? orders
        : orders.filter(
            (o) => !INACTIVE_STATUSES.includes(o.status as (typeof INACTIVE_STATUSES)[number]),
          );
    const scoped = status ? filtered.filter((o) => o.status === status) : filtered;

    const payload = await Promise.all(
      scoped.map(async (o) => {
        const payment = await sharedPaymentRepo.getByOrderId(o.id);
        const customer = await sharedIdentityRepo.getById(o.user_id);
        return {
          id: o.id,
          status: o.status,
          total_amount: o.total_amount,
          restaurant_name: o.restaurant_name ?? null,
          scheduled_pickup_time: o.scheduled_pickup_time ?? null,
          items: o.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            base_price: i.base_price,
            customizations: i.customizations,
          })),
          pickup_otp: o.pickup_otp,
          checked_in: o.checked_in,
          created_at: o.created_at,
          payment_method: payment?.method ?? null,
          payment_status: payment?.status ?? null,
          customer_phone: customer?.phone ?? null,
          is_catering: o.is_catering ?? false,
          headcount: o.headcount ?? null,
        };
      }),
    );

    ok(res, payload);
  }),
);
