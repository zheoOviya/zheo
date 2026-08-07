import "dotenv/config";
import { createServer } from "node:http";
import { config } from "./config";
import { createApp } from "./app";
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
