import "dotenv/config";
import { createServer } from "node:http";
import { config } from "./config";
import { createApp } from "./app";
import { closeDb } from "./lib/db";
import { getRedis } from "./lib/redis";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./lib/websocket";
import { seedPhase4DemoData } from "./seed/phase4Demo";

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

const app = createApp();
const server = createServer(app);

const DEFAULT_ACCESS_SECRET = "dev-access-secret-change-in-production";
const DEFAULT_REFRESH_SECRET = "dev-refresh-secret-change-in-production";

if (
  config.env === "production" &&
  (config.jwt.accessSecret === DEFAULT_ACCESS_SECRET ||
    config.jwt.refreshSecret === DEFAULT_REFRESH_SECRET)
) {
  logger.error({
    message:
      "jwt_default_secret_in_production: JWT secrets are using dev defaults. " +
      "Set JWT_SECRET and JWT_REFRESH_SECRET before going live.",
  });
} else if (
  config.jwt.accessSecret === DEFAULT_ACCESS_SECRET ||
  config.jwt.refreshSecret === DEFAULT_REFRESH_SECRET
) {
  logger.warn({
    message:
      "jwt_default_secret_in_use: JWT secrets fall back to dev defaults. " +
      "Set JWT_SECRET and JWT_REFRESH_SECRET in non-development environments.",
  });
}

// Phase 4 demo data (dev only): Chain Owner + "SnakZap Mumbai Chain".
seedPhase4DemoData();

// WebSocket upgrade handling on the same HTTP server (EOS Layer 1, P05)
initWebSocketServer(server);

server.listen(config.port, () => {
  logger.info({
    message: "server_started",
    port: config.port,
    env: config.env,
  });
});

function shutdown(signal: string) {
  logger.info({ message: "shutdown_initiated", signal });
  server.close(async () => {
    logger.info({ message: "http_server_closed" });
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
