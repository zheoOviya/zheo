import { createServer, type Server } from "node:http";
import { logger } from "./lib/logger";
import { createShutdownCoordinator } from "./lib/shutdown";

// ============================================
// Subprocess fixture for shutdown runtime proof.
//
// Exercises the ACTUAL shutdown coordinator from lib/shutdown.ts in a real
// child process. Resource cleanups (server/Redis/DB) are injectable fakes so
// failure and hang scenarios can be driven deterministically; process.exit is
// NEVER mocked - real exit codes are captured by the parent test process.
//
// Modes (FIXTURE_MODE):
//   uncaught           throw a real Error after startup-ready
//   unhandled          detached Promise.reject after startup-ready
//   sigterm            wait for external SIGTERM
//   escalation         SIGTERM with slow Redis cleanup + mid-cleanup fatal
//   hung_server        server.close callback never completes
//   early_fatal        fatal before any HTTP server is created
//   sigterm_startup    signal while startup is deliberately paused
//   pending_listen     listen requested, shutdown before 'listening' callback
//   late_fatal         graceful finalize, then a fatal lands before the actual
//                      process exit (must escalate pending exit 0 -> 1)
//   seed_import        SIGTERM while a delayed dynamic seed import is in flight;
//                      the seed side effect must NOT run after shutdown
// ============================================

const mode = process.env.FIXTURE_MODE ?? "sigterm";
const timeoutMs = Number(process.env.FIXTURE_TIMEOUT_MS ?? 3000);
const fatalAfterReady = process.env.FIXTURE_FATAL === "1";

const shutdown = createShutdownCoordinator(timeoutMs);

function mark(msg: string) {
  logger.info({ message: `FIXTURE:${msg}` });
}

// Same handler pattern as the production index.ts.
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
process.on("SIGTERM", () => shutdown.requestShutdown({ reason: "SIGTERM", exitCode: 0 }));
process.on("SIGINT", () => shutdown.requestShutdown({ reason: "SIGINT", exitCode: 0 }));

function redisCleanup() {
  const kind = process.env.FIXTURE_REDIS ?? "ok";
  if (kind === "ok") {
    return async () => {
      mark("redis_done");
    };
  }
  if (kind === "slow") {
    return async () => {
      mark("redis_start");
      await new Promise((r) => setTimeout(r, 800));
      mark("redis_done");
    };
  }
  if (kind === "hung") {
    return async () => {
      mark("redis_start");
      await new Promise(() => {});
    };
  }
  // fail
  return async () => {
    mark("redis_start");
    throw new Error("redis quit failed");
  };
}

function dbCleanup() {
  const kind = process.env.FIXTURE_DB ?? "ok";
  if (kind === "ok") {
    return async () => {
      mark("db_done");
    };
  }
  if (kind === "hung") {
    return async () => {
      mark("db_start");
      await new Promise(() => {});
    };
  }
  // fail
  return async () => {
    mark("db_start");
    throw new Error("db close failed");
  };
}

function startReadyApp(): Server {
  const server = createServer((_req, res) => {
    res.end("ok");
  });
  shutdown.registerServer(server);
  shutdown.registerResource(async () => {
    mark("server_closed");
  });
  shutdown.registerResource(redisCleanup());
  shutdown.registerResource(dbCleanup());
  return server;
}

function listenAndReady(server: Server) {
  shutdown.markListenRequested();
  server.listen(0, () => {
    mark("listening");
    mark("ready");
  });
}

async function run() {
  switch (mode) {
    case "uncaught": {
      const server = startReadyApp();
      listenAndReady(server);
      setTimeout(() => {
        throw new Error("PROBE_UNCAUGHT");
      }, 400);
      break;
    }
    case "unhandled": {
      const server = startReadyApp();
      listenAndReady(server);
      setTimeout(() => {
        void Promise.reject(new Error("PROBE_REJECT"));
      }, 400);
      break;
    }
    case "sigterm": {
      const server = startReadyApp();
      listenAndReady(server);
      if (fatalAfterReady) {
        setTimeout(() => {
          throw new Error("PROBE_FATAL_AFTER_READY");
        }, 400);
      }
      break;
    }
    case "escalation": {
      const server = startReadyApp();
      listenAndReady(server);
      process.on("SIGTERM", () => {
        setTimeout(() => {
          throw new Error("ESCALATE_FATAL");
        }, 200);
      });
      break;
    }
    case "hung_server": {
      const server = createServer((_req, res) => {
        res.end("ok");
      });
      shutdown.registerServer(server);
      shutdown.registerResource(async () => {
        mark("server_closed");
      });
      shutdown.registerResource(redisCleanup());
      shutdown.registerResource(dbCleanup());
      shutdown.markListenRequested();
      server.listen(0, () => {
        mark("listening");
        mark("ready");
      });
      // Override so the close callback never completes -> overall deadline must fire.
      (server as unknown as { close: (cb?: (err?: Error) => void) => Server }).close = () =>
        server;
      break;
    }
    case "early_fatal": {
      // Only the Redis cleanup is registered; no HTTP server has been created.
      shutdown.registerResource(redisCleanup());
      mark("ready");
      setTimeout(() => {
        throw new Error("EARLY_FATAL");
      }, 400);
      break;
    }
    case "sigterm_startup": {
      const startupDelay = Number(process.env.FIXTURE_STARTUP_MS ?? 5000);
      // Keep cleanup busy long enough for the delayed startup continuation to
      // observe shutdown.started() and cancel itself.
      shutdown.registerResource(async () => {
        await new Promise((r) => setTimeout(r, startupDelay + 800));
        mark("guard_cleanup_done");
      });
      mark("startup_begin");
      setTimeout(() => {
        if (shutdown.started()) {
          mark("startup_cancelled");
          return;
        }
        const server = startReadyApp();
        listenAndReady(server);
      }, startupDelay);
      mark("ready_startup_paused");
      break;
    }
    case "pending_listen": {
      const server = createServer((_req, res) => {
        res.end("ok");
      });
      shutdown.registerServer(server);
      shutdown.registerResource(async () => {
        mark("server_closed");
      });
      shutdown.registerResource(redisCleanup());
      shutdown.registerResource(dbCleanup());
      shutdown.markListenRequested();
      server.listen(0);
      shutdown.requestShutdown({ reason: "PENDING_LISTEN_PROBE", exitCode: 1 });
      break;
    }
    case "late_fatal": {
      // Graceful shutdown finishes -> finalize arms an unref'd forced exit at
      // +25ms. The LAST cleanup task schedules a ref'd fatal that fires at
      // +15ms: after finalize (cleanup completes) but before the forced exit.
      // The real exit code must escalate to 1.
      const server = createServer((_req, res) => {
        res.end("ok");
      });
      shutdown.registerServer(server);
      shutdown.registerResource(async () => {
        mark("server_closed");
      });
      shutdown.registerResource(redisCleanup());
      shutdown.registerResource(dbCleanup());
      shutdown.registerResource(async () => {
        setTimeout(() => {
          throw new Error("LATE_FATAL");
        }, 15).ref();
      });
      shutdown.markListenRequested();
      server.listen(0, () => {
        mark("listening");
        mark("ready");
      });
      break;
    }
    case "seed_import": {
      // Mirrors index.ts: the seed side effect is only run AFTER the dynamic
      // import resolves AND shutdown.started() is still false. A SIGTERM
      // arriving while the module's top-level await sleeps must suppress the
      // seed, websocket init and listen.
      mark("startup_begin");
      // Register cleanup up front so a SIGTERM landing while the seed import
      // is still in flight keeps the shutdown open until the import resolves
      // (FIXTURE_REDIS=slow holds it long enough).
      shutdown.registerResource(redisCleanup());
      shutdown.registerResource(dbCleanup());
      mark("seed_import_pending");
      // Simulate the seed import's evaluation still being in flight: a SIGTERM
      // arriving during this await must, once the import resolves, prevent the
      // seed side effect, websocket init and listen.
      await new Promise((r) => setTimeout(r, Number(process.env.FIXTURE_SEED_DELAY_MS ?? 600)));
      const { seedPhase4DemoData } = await import("./shutdown.seedfixture");
      mark("seed_import_resolved");
      if (shutdown.started()) {
        mark("seed_guard_triggered");
        return;
      }
      seedPhase4DemoData();
      mark("seed_called");
      const { initWebSocketServer } = await import("./lib/websocket");
      if (shutdown.started()) return;
      const srv = createServer((_req, res) => {
        res.end("ok");
      });
      shutdown.registerServer(srv);
      shutdown.registerResource(async () => {
        mark("server_closed");
      });
      initWebSocketServer(srv);
      shutdown.markListenRequested();
      srv.listen(0, () => {
        mark("listening");
      });
      break;
    }
    default: {
      const server = startReadyApp();
      listenAndReady(server);
    }
  }
}

void run();
