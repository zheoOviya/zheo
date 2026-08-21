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
import { registerVendorNotificationHandlers } from "./services/notifications";
import { initEventSubscriber } from "./lib/eventBus";
import { metrics, metricsRouter } from "./routes/metrics";
import { adminRouter } from "./routes/admin";
import { vendorApplicationRouter } from "./routes/vendorApplications";
import { requireVendorOrAdmin } from "./middleware/requireRoles";
import { getRedis } from "./lib/redis";
import { probePostgres } from "./lib/db";

// EOS Layer 1 wiring: loyalty + retention contexts subscribe to
// OrderPickedUp so stamp cards fill themselves, wallet cashback is
// credited, and pickup streaks advance when an order is picked up.
registerLoyaltyEventHandlers();
registerRetentionEventHandlers();
registerVendorNotificationHandlers();
void initEventSubscriber();

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
  app.use(
    cors({
      // Exact-match allowlist plus wildcard dev/preview hosts so the hosted
      // preview origins (e.g. *.monkeycode-ai.live) can call the API directly.
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, true);
          return;
        }
        const exact = config.cors.origins
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean);
        if (exact.includes(origin)) {
          cb(null, true);
          return;
        }
        try {
          const host = new URL(origin).hostname;
          const wildcards = config.cors.wildcardHosts
            .split(",")
            .map((w) => w.trim())
            .filter(Boolean);
          const allowed = wildcards.some((suffix) => {
            const s = suffix.startsWith(".") ? suffix : `.${suffix}`;
            return host === s.slice(1) || host.endsWith(s);
          });
          cb(null, allowed);
        } catch {
          cb(null, false);
        }
      },
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );
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

  app.get("/health", async (_req, res) => {
    const status: Record<string, string> = { api: "ok" };
    let healthy = true;

    try {
      const redis = getRedis();
      status.redis = redis.status === "ready" ? "ok" : redis.status;
      if (redis.status !== "ready") healthy = false;
    } catch {
      status.redis = "unreachable";
      healthy = false;
    }

    if (process.env.NODE_ENV === "test") {
      status.postgres = "test";
    } else if (process.env.USE_MEMORY_REPOS === "true") {
      // Dev/preview boot with in-memory repos (see index.ts probe).
      status.postgres = "memory";
    } else {
      // Real PostgreSQL in use: issue an actual `SELECT 1` so a dead DB
      // degrades the health response instead of a lazy pool returning "ok".
      try {
        const up = await probePostgres(1500);
        status.postgres = up ? "ok" : "unavailable";
        if (!up) healthy = false;
      } catch {
        status.postgres = "unavailable";
        healthy = false;
      }
    }

    const httpStatus = healthy ? 200 : 503;
    res.status(httpStatus).json({
      success: healthy,
      data: { status },
      error: null,
    });
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
  app.use("/api/vendor", requireVendorOrAdmin, vendorRouter);
  app.use("/api/vendor", requireVendorOrAdmin, vendorOpsRouter);
  app.use("/api/vendor", requireVendorOrAdmin, chainsRouter);
  app.use(`${API_PREFIX}/vendor-applications`, vendorApplicationRouter);
  app.use(`${API_PREFIX}/admin`, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
