import type { Server } from "node:http";
import { logger } from "./logger";

// ============================================
// Process shutdown coordinator.
//
// Distinguishes NORMAL shutdown (SIGTERM/SIGINT -> exit 0) from FATAL
// shutdown (uncaughtException/unhandledRejection -> exit 1). One overall
// deadline stays armed across HTTP drain -> Redis cleanup -> Postgres
// cleanup; it is only cleared after successful cleanup finishes. Any stage
// that hangs past the deadline forces a non-zero exit.
//
// Invariants:
//   - exit severity is monotonic: 0 may become 1, 1 never becomes 0.
//   - cleanup + finalization run at most once.
//   - resources registered after shutdown begins are refused.
//   - the deadline is never unref'd (it must always be able to fire).
// ============================================

export type ShutdownSeverity = 0 | 1;

export interface ShutdownRequest {
  reason: string;
  exitCode: ShutdownSeverity;
}

export interface ShutdownCoordinator {
  started(): boolean;
  requestShutdown(req: ShutdownRequest): void;
  registerResource(cleanup: () => Promise<void>): void;
  registerServer(server: Server): void;
  markListenRequested(): void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function createShutdownCoordinator(
  timeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): ShutdownCoordinator {
  let state: "idle" | "shutting-down" | "done" = "idle";
  let finalExitCode: ShutdownSeverity = 0;
  let finalizing = false;
  let deadline: NodeJS.Timeout | null = null;
  let listenRequested = false;
  const cleanupTasks: Array<() => Promise<void>> = [];

  function started(): boolean {
    return state !== "idle";
  }

  function finalize(): void {
    if (finalizing) return;
    finalizing = true;
    state = "done";
    if (deadline) {
      clearTimeout(deadline);
      deadline = null;
    }
    logger.info({ message: "shutdown_finalized", exitCode: finalExitCode });
    // Prefer natural exit so pending stdout/stderr fully flush. The unref'd
    // fallback guarantees termination even if a stray ref'd handle keeps the
    // loop alive past the point where the server/Redis/PG are already closed.
    process.exitCode = finalExitCode;
    setTimeout(() => process.exit(finalExitCode), 25).unref();
  }

  function armDeadline(): void {
    deadline = setTimeout(() => {
      logger.error({ message: "shutdown_timeout", finalExitCode });
      finalExitCode = 1;
      finalize();
    }, timeoutMs);
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ERR_SERVER_NOT_RUNNING") {
            logger.warn({ message: "http_server_close_error", error: err.message });
          }
        }
        resolve();
      });
    });
  }

  async function runCleanup(): Promise<void> {
    for (const task of cleanupTasks) {
      try {
        await task();
      } catch (err) {
        logger.error({
          message: "shutdown_cleanup_error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    finalize();
  }

  function requestShutdown(req: ShutdownRequest): void {
    if (state === "done") {
      // finalize() only armed an unref'd forced exit; the process has not
      // actually exited yet. A late fatal must still escalate the pending
      // exit code rather than being dropped because finalization already ran.
      // The eventual exit reads finalExitCode / process.exitCode at exit time,
      // so bumping both here is enough - no second exit path is introduced.
      if (req.exitCode === 1 && finalExitCode === 0) {
        finalExitCode = 1;
        process.exitCode = 1;
        logger.warn({
          message: "shutdown_fatal_after_finalize",
          reason: req.reason,
          finalExitCode,
        });
      }
      return;
    }
    if (state === "shutting-down") {
      if (req.exitCode === 1) {
        finalExitCode = 1;
      }
      logger.warn({
        message: "shutdown_event_while_shutting_down",
        reason: req.reason,
        finalExitCode,
      });
      return;
    }
    state = "shutting-down";
    finalExitCode = req.exitCode;
    logger.info({ message: "shutdown_initiated", reason: req.reason, finalExitCode });
    armDeadline();
    void runCleanup();
  }

  function registerResource(cleanup: () => Promise<void>): void {
    if (state !== "idle") {
      logger.warn({ message: "shutdown_registration_refused" });
      return;
    }
    cleanupTasks.push(cleanup);
  }

  function registerServer(server: Server): void {
    registerResource(async () => {
      if (!listenRequested) {
        // Server was created but listen was never requested. Do not attempt
        // to close it; the startup path is required never to call listen
        // after shutdown begins.
        return;
      }
      // Covers both "listen requested but 'listening' event pending" and
      // "actively listening". Node cancels a pending listen cleanly and
      // drains an active one. An ERR_SERVER_NOT_RUNNING from an early close
      // is treated as a completed server cleanup, not a fatal error.
      await closeServer(server);
    });
  }

  function markListenRequested(): void {
    listenRequested = true;
  }

  return {
    started,
    requestShutdown,
    registerResource,
    registerServer,
    markListenRequested,
  };
}
