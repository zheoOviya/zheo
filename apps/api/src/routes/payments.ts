import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { rateLimiter } from "../middleware/rateLimiter";
import { sharedGiftRepo, sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
import { PaymentService, type PaymentMethod } from "../services/payments";

// ============================================
// Payments context routes - /api/v1/payments
// O04 Pre-paid Button: create Razorpay order,
// receive webhook callback with idempotency.
// Indian market methods: UPI / card / netbanking /
// wallet route through the Razorpay checkout; "cod"
// means pay at the pickup counter (no gateway).
// ============================================

const PaymentMethodSchema = z.enum(["upi", "card", "netbanking", "wallet", "cod"]);

const CreateOrderSchema = z.object({
  order_id: z.string().uuid(),
  method: PaymentMethodSchema.default("upi"),
});

const paymentService = new PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo);

export const paymentsRouter: Router = Router();

const paymentsLimiter = rateLimiter({
  prefix: "payments",
  max: 20,
  windowMs: 60_000,
  identifier: (req) => req.ip ?? "unknown",
  failClosed: true,
});

paymentsRouter.use(paymentsLimiter);

paymentsRouter.post(
  "/create-order",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateOrderSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid request body", 400, body.error.flatten());
    }

    const userId = res.locals.userId as string;

    const result = await paymentService.createPaymentOrder(
      body.data.order_id,
      userId,
      body.data.method as PaymentMethod,
    );

    // 202 Accepted: the intent is still being prepared (another process holds
    // the initiation lease). The client should retry shortly; no
    // razorpay_order_id is present yet, so the checkout must NOT open.
    if (result.payment_state === "IN_PROGRESS") {
      ok(res, result, 202);
      return;
    }
    ok(res, result, 200);
  }),
);

paymentsRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    if (!signature) {
      throw new AppError("MISSING_SIGNATURE", "X-Razorpay-Signature header is required", 401);
    }

    // HMAC must cover the exact bytes Razorpay sent — JSON.stringify(req.body)
    // re-serializes and breaks the signature. req.rawBody is captured by the
    // body-parser middleware in app.ts.
    const rawBody =
      typeof req.rawBody === "string"
        ? req.rawBody
        : req.rawBody?.toString("utf8") ?? JSON.stringify(req.body);

    const result = await paymentService.processWebhook(rawBody, signature);

    ok(res, {
      processed: result.processed,
      idempotent: result.idempotent,
      order_status: result.orderStatus,
      gift_status: result.giftStatus,
    });
  }),
);

export { sharedPaymentRepo as paymentRepo, sharedOrderRepo as paymentOrderRepo };
