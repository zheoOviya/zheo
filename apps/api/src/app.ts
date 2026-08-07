import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { config } from "./config";
import { correlationIdMiddleware } from "./lib/correlation";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { rateLimiter } from "./middleware/rateLimiter";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { discoveryRouter } from "./routes/discovery";
import { ordersRouter } from "./routes/orders";
import { groupOrdersRouter } from "./routes/groupOrders";
import { paymentsRouter } from "./routes/payments";
import { fulfillmentRouter, vendorRouter } from "./routes/fulfillment";
import { vendorOpsRouter } from "./routes/vendorOps";
import { posWebhookRouter } from "./routes/posWebhook";
import { etaRouter, loyaltyRouter } from "./routes/loyalty";
import { usersRouter } from "./routes/users";
import { cartRouter } from "./routes/cart";
import { cateringRouter } from "./routes/catering";
import { chainsRouter } from "./routes/chains";
import { wearRouter } from "./routes/wear";
import { supportRouter } from "./routes/support";
import { registerLoyaltyEventHandlers } from "./services/loyalty";
import { registerRetentionEventHandlers } from "./services/retention";
import { metrics, metricsRouter } from "./routes/metrics";
import { adminRouter } from "./routes/admin";
import { requireRole } from "./middleware/requireRoles";

// EOS Layer 1 wiring: loyalty + retention contexts subscribe to
// OrderPickedUp so stamp cards fill themselves, wallet cashback is
// credited, and pickup streaks advance when an order is picked up.
registerLoyaltyEventHandlers();
registerRetentionEventHandlers();

export const API_PREFIX = "/api/v1";

const apiLimiter = rateLimiter({
  prefix: "api",
  max: config.rateLimit.apiMaxPerMinute,
  windowMs: 60_000,
  identifier: (req) => req.ip ?? "unknown",
});

export function createApp(): Express {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(correlationIdMiddleware);

  // Request logging + RED metrics capture
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      metrics.requests += 1;
      metrics.totalDurationMs += Date.now() - started;
      if (res.statusCode >= 400) metrics.errors += 1;
      logger.info({
        message: "http_request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        correlation_id: res.locals.correlationId,
      });
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ success: true, data: { status: "ok", service: "snakzap-api" }, error: null });
  });

  // Metrics endpoint is intentionally NOT behind the API rate limiter
  // so Prometheus scraping is never throttled.
  app.use("/metrics", metricsRouter);

  // General API rate limiting (100/min/IP) applies to all versioned routes.
  app.use(API_PREFIX, apiLimiter);
  app.use(`${API_PREFIX}/auth`, authRouter);
  app.use(API_PREFIX, catalogRouter);
  app.use(`${API_PREFIX}/discovery`, discoveryRouter);
  app.use(`${API_PREFIX}/orders`, groupOrdersRouter);
  app.use(`${API_PREFIX}/orders`, ordersRouter);
  app.use(`${API_PREFIX}/orders`, cateringRouter);
  app.use(`${API_PREFIX}/wear`, wearRouter);
  app.use(`${API_PREFIX}/support`, supportRouter);
  app.use(API_PREFIX, cartRouter);
  app.use(`${API_PREFIX}/payments`, paymentsRouter);
  app.use(API_PREFIX, fulfillmentRouter);
  app.use(`${API_PREFIX}/loyalty`, loyaltyRouter);
  app.use(API_PREFIX, etaRouter);
  app.use(API_PREFIX, usersRouter);
  app.use(`${API_PREFIX}/webhooks/pos`, posWebhookRouter);
  // A-01: Vendor routes gated behind VENDOR/ADMIN role.
  app.use("/api/vendor", requireRole("VENDOR_OWNER", "VENDOR_STAFF", "ADMIN", "SUPER_ADMIN"), vendorRouter);
  app.use("/api/vendor", requireRole("VENDOR_OWNER", "VENDOR_STAFF", "ADMIN", "SUPER_ADMIN"), vendorOpsRouter);
  app.use("/api/vendor", chainsRouter);
  app.use(`${API_PREFIX}/admin`, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
