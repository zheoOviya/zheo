import "dotenv/config";
import { createServer } from "node:http";
import { config } from "./config";
import { closeDb, probePostgres } from "./lib/db";
import { getRedisIfExists } from "./lib/redis";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./lib/websocket";
import { assertSecureConfig } from "./env";
import { createShutdownCoordinator } from "./lib/shutdown";

// The shutdown coordinator is created first so fatal handlers are active
// from process startup, before any meaningful startup work begins.
const shutdown = createShutdownCoordinator();

// Resilience: never let an unhandled async failure take the process down
// silently. Log the original fatal details FIRST, then request a FATAL
// shutdown (exit code 1) instead of only logging.
process.on("unhandledRejection", (reason) => {
  logger.error({
    message: "unhandled_rejection",
    error: reason instanceof Error ? reason.message : String(reason),
  });
  shutdown.requestShutdown({ reason: "unhandled_rejection", exitCode: 1 });
});
process.on("uncaughtException", (err) => {
  logger.error({ message: "uncaught_exception", error: err.message, stack: err.stack });
  shutdown.requestShutdown({ reason: "uncaught_exception", exitCode: 1 });
});

// Normal signal path: controlled cleanup, exit 0.
process.on("SIGTERM", () => shutdown.requestShutdown({ reason: "SIGTERM", exitCode: 0 }));
process.on("SIGINT", () => shutdown.requestShutdown({ reason: "SIGINT", exitCode: 0 }));

async function main() {
  // Fail fast on insecure production configuration (weak/missing JWT secrets,
  // or the dev auth bypass left enabled). Throws -> startup_error -> exit 1.
  assertSecureConfig();

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

  // Register cleanup in shutdown order: HTTP drain first, then Redis, then
  // Postgres. The server's listen lifecycle is tracked by the coordinator so
  // a pending-listen shutdown still attempts a real close.
  shutdown.registerServer(server);
  shutdown.registerResource(async () => {
    // Never call getRedis() merely for cleanup: that could instantiate a new
    // client. Only quit when a client already exists.
    const redis = getRedisIfExists();
    if (redis) {
      await redis.quit();
      logger.info({ message: "redis_disconnected" });
    }
  });
  shutdown.registerResource(async () => {
    // closeDb() is a safe no-op when no pool exists.
    await closeDb();
    logger.info({ message: "postgres_pool_closed" });
  });

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

  // Startup cancellation: once shutdown has begun, do not start any later
  // startup stage (seeds, websocket init, server listen). The check is
  // repeated after EVERY awaited boundary so a shutdown that lands while a
  // dynamic import (or any other await) is in flight still prevents the
  // corresponding side effect from running.
  if (shutdown.started()) return;

  // Phase 4 demo data (dev only): Chain Owner + "SnakZap Mumbai Chain".
  const { seedPhase4DemoData } = await import("./seed/phase4Demo");
  if (shutdown.started()) return;
  seedPhase4DemoData();

  // Catalog seed data (dev/staging only): when Postgres is the active store,
  // populate restaurants/menu_items (and their vendor-owner users) so the
  // Drizzle-backed catalog is not empty. No-op in memory mode.
  const { seedCatalogData } = await import("./seed/catalogSeed");
  if (shutdown.started()) return;
  await seedCatalogData();

  if (shutdown.started()) return;

  // Daily gift expiry + refund sweep (social gifting). Unref'd timer so it
  // never keeps the process alive.
  const { startGiftExpirySweep } = await import("./services/giftExpirySweep");
  if (shutdown.started()) return;
  startGiftExpirySweep();

  if (shutdown.started()) return;

  // WebSocket upgrade handling on the same HTTP server (EOS Layer 1, P05)
  initWebSocketServer(server);

  // Track that listen was requested so the coordinator can attempt a real
  // close even while the "listening" event is still pending.
  shutdown.markListenRequested();
  server.listen(config.port, () => {
    if (shutdown.started()) return;
    logger.info({
      message: "server_started",
      port: config.port,
      env: config.env,
    });
  });
}

// Startup failures (sync throws or rejected awaits) are routed to fatal
// shutdown exactly once here. Do not rethrow: the .catch above consumes the
// rejection, so it never also surfaces as an unhandledRejection event.
void main().catch((error) => {
  logger.error({
    message: "startup_error",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  shutdown.requestShutdown({ reason: "startup_error", exitCode: 1 });
});
