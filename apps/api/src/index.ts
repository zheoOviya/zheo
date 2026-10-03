import "dotenv/config";
import { createServer } from "node:http";
import { config } from "./config";
import { closeDb, probePostgres } from "./lib/db";
import { getRedis, assertRedisConfig } from "./lib/redis";
import { shutdownEventSubscriber } from "./lib/eventBus";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./lib/websocket";
import { assertSecureConfig } from "./env";

// Resilience: never let an unhandled async failure take the process down.
process.on("unhandledRejection", (reason) => {
  logger.error({
    message: "unhandled_rejection",
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on("uncaughtException", (err) => {
  logger.error({ message: "uncaught_exception", error: err.message, stack: err.stack });
});

async function main() {
  // Fail fast on insecure production configuration (weak/missing JWT secrets,
  // or the dev auth bypass left enabled). Throws -> process exits non-zero.
  assertSecureConfig();

  // Fail closed when production lacks a real Redis backend. The in-process
  // MemoryRedis stub is dev/test-only; silently using it in production would
  // make OTP storage, token revocation, rate limiting, catalog cache, and
  // EventBus/WebSocket state process-local and non-durable. Throws
  // RedisConfigError -> process exits non-zero. No silent memory fallback.
  assertRedisConfig();

  // Probe PostgreSQL before any repository module loads. Pool construction is
  // lazy (never opens a socket), so a live database must be verified with a
  // real query. When unreachable (e.g. preview without Postgres), fall back to
  // in-memory repositories so the whole API keeps working. In production we
  // intentionally do NOT fall back - a silent memory DB would hide data loss.
  if (config.env !== "production") {
    const dbUp = await probePostgres();
    if (!dbUp) {
      logger.warn({
        message:
          "postgres_unreachable: falling back to in-memory repositories",
      });
      process.env.USE_MEMORY_REPOS = "true";
    }
  }

  const { createApp } = await import("./app");
  const app = createApp();
  const server = createServer(app);

  const DEFAULT_ACCESS_SECRET = "dev-access-secret-change-in-production";
  const DEFAULT_REFRESH_SECRET = "dev-refresh-secret-change-in-production";

  if (
    config.env !== "production" &&
    (config.jwt.accessSecret === DEFAULT_ACCESS_SECRET ||
      config.jwt.refreshSecret === DEFAULT_REFRESH_SECRET)
  ) {
    logger.warn({
      message:
        "jwt_default_secret_in_use: JWT secrets fall back to dev defaults. " +
        "Set JWT_SECRET and JWT_REFRESH_SECRET before deploying to production.",
    });
  }

  // Phase 4 demo data (dev only): Chain Owner + "SnakZap Mumbai Chain".
  const { seedPhase4DemoData } = await import("./seed/phase4Demo");
  seedPhase4DemoData();

  // Catalog seed data (dev/staging only): when Postgres is the active store,
  // populate restaurants/menu_items (and their vendor-owner users) so the
  // Drizzle-backed catalog is not empty. No-op in memory mode.
  const { seedCatalogData } = await import("./seed/catalogSeed");
  await seedCatalogData();

  // Deterministic Dine-In E2E fixture (UI8-A-R2): memory-only, fail-closed
  // bootstrap that seeds exactly one resolvable table when explicitly enabled
  // (DINE_IN_E2E_FIXTURE=true, non-production, memory storage mode). The
  // fixture function owns the guards; this hook only gates invocation.
  if (process.env.DINE_IN_E2E_FIXTURE === "true") {
    const { seedDineInE2eFixture } = await import("./seed/dineInE2eFixture");
    await seedDineInE2eFixture();
  }

  // Daily gift expiry + refund sweep (social gifting). Unref'd timer so it
  // never keeps the process alive.
  const { startGiftExpirySweep } = await import("./services/giftExpirySweep");
  startGiftExpirySweep();

  // Notification retry sweep (NOTIFICATION-RETRY-SWEEPER-A2): drain due
  // notification retries once on boot, then periodically, so a retryable row
  // cannot stay dormant until an unrelated vendor event arrives. Unref'd timer;
  // stopped explicitly during shutdown before DB teardown.
  const { startNotificationRetrySweep, stopNotificationRetrySweep } = await import(
    "./services/notifications"
  );
  startNotificationRetrySweep();

  // Payment reconciliation sweep (PAYMENT_RECONCILIATION-B1): converges local
  // payment/order state against gateway truth. Unref'd timer; read-only with
  // respect to money (it never submits refunds). Stopped explicitly during
  // shutdown before DB teardown.
  const { startPaymentReconciliationSweep, stopPaymentReconciliationSweep } = await import(
    "./services/paymentReconciliation"
  );
  startPaymentReconciliationSweep();

  // Durable event-outbox relay (EVT-RELAY-BOOTSTRAP): publishes committed
  // transactional-outbox rows. Always runs (no disable flag) so durable events
  // cannot be stranded in production. Boot tick + bounded periodic ticks on an
  // unref'd timer; stopped explicitly during shutdown before Redis/DB teardown.
  const { startEventOutboxRelay, stopEventOutboxRelay } = await import(
    "./services/eventOutboxRelay"
  );
  const { sharedEventOutboxRepo } = await import("./repositories/shared");
  startEventOutboxRelay({ repo: sharedEventOutboxRepo });

  // WebSocket upgrade handling on the same HTTP server (EOS Layer 1, P05)
  initWebSocketServer(server);

  server.listen(config.port, () => {
    logger.info({
      message: "server_started",
      port: config.port,
      env: config.env,
    });
  });

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ message: "shutdown_initiated", signal });
    stopNotificationRetrySweep();
    stopPaymentReconciliationSweep();
    // Stop scheduling relay ticks immediately; the awaited stop inside the
    // close callback ensures any in-flight tick settles before Redis/DB close.
    void stopEventOutboxRelay();
    server.close(async () => {
      logger.info({ message: "http_server_closed" });
      await stopEventOutboxRelay();
      await shutdownEventSubscriber();
      try {
        await getRedis().quit();
        logger.info({ message: "redis_disconnected" });
      } catch {
        // ignore
      }
      try {
        await closeDb();
        logger.info({ message: "postgres_pool_closed" });
      } catch {
        // ignore
      }
      process.exit(0);
    });
    setTimeout(() => {
      logger.error({ message: "shutdown_timeout", signal });
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
