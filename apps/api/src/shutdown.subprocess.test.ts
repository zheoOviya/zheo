import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ============================================
// 7C.2 runtime proof: real subprocesses.
//
// Spawns shutdown.fixture.ts (a real node process, tsx-registered) for each
// scenario and asserts the actual exit code, the ordered cleanup marker
// sequence, and the coordinator's log events. process.exit is NEVER mocked;
// exit codes come from the real child. The fixture drives the ACTUAL
// createShutdownCoordinator from lib/shutdown.ts.
// ============================================

const fixturePath = fileURLToPath(new URL("./shutdown.fixture.ts", import.meta.url));
const apiDir = path.resolve(path.dirname(fixturePath), "..");

interface Event {
  message: string;
  data: Record<string, unknown>;
}

interface FixtureResult {
  code: number | null;
  events: Event[];
  stderr: string;
}

interface RunOptions {
  mode: string;
  env?: Record<string, string>;
  signalOnMarker?: string;
  timeoutMs?: number;
}

function runFixture(opts: RunOptions): Promise<FixtureResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ["--import=tsx", fixturePath],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          NODE_ENV: "production",
          FIXTURE_MODE: opts.mode,
          ...opts.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const events: Event[] = [];
    let stdoutBuf = "";
    let stderrBuf = "";
    let signaled = false;

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 20_000);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let data: Record<string, unknown> = {};
        let message = trimmed;
        try {
          data = JSON.parse(trimmed) as Record<string, unknown>;
          message = String(data.message ?? trimmed);
        } catch {
          // Non-JSON line (e.g. a Node warning); keep the raw text.
        }
        events.push({ message, data });
      }
      if (opts.signalOnMarker && !signaled) {
        const hit = events.some((e) => e.message === `FIXTURE:${opts.signalOnMarker}`);
        if (hit) {
          signaled = true;
          child.kill("SIGTERM");
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, events, stderr: stderrBuf });
    });
    child.on("error", reject);
  });
}

const isKey = (m: string) => m.startsWith("FIXTURE:") || m.startsWith("shutdown_") || m.includes("uncaught") || m.includes("unhandled");

function expectTrace(
  result: FixtureResult,
  expected: string[],
  exitCode: number,
  label: string,
): void {
  const trace = result.events.map((e) => e.message).filter(isKey);
  expect(trace, `${label}: marker/log trace`).toEqual(expected);
  expect(result.code, `${label}: exit code`).toBe(exitCode);
}

function eventOf(result: FixtureResult, message: string): Event | undefined {
  return result.events.find((e) => e.message === message);
}

describe("shutdown coordinator: real subprocess runtime proof", () => {
  it(
    "uncaught exception -> fatal exit 1 with full ordered cleanup",
    async () => {
      const r = await runFixture({ mode: "uncaught" });
      expectTrace(
        r,
        [
          "FIXTURE:listening",
          "FIXTURE:ready",
          "uncaught_exception",
          "shutdown_initiated",
          "FIXTURE:server_closed",
          "FIXTURE:redis_done",
          "FIXTURE:db_done",
          "shutdown_finalized",
        ],
        1,
        "uncaught",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("uncaught_exception");
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "unhandled rejection -> fatal exit 1 with full ordered cleanup",
    async () => {
      const r = await runFixture({ mode: "unhandled" });
      expectTrace(
        r,
        [
          "FIXTURE:listening",
          "FIXTURE:ready",
          "unhandled_rejection",
          "shutdown_initiated",
          "FIXTURE:server_closed",
          "FIXTURE:redis_done",
          "FIXTURE:db_done",
          "shutdown_finalized",
        ],
        1,
        "unhandled",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("unhandled_rejection");
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "SIGTERM -> graceful exit 0 with ordered drain -> redis -> db",
    async () => {
      const r = await runFixture({ mode: "sigterm", signalOnMarker: "ready" });
      expectTrace(
        r,
        [
          "FIXTURE:listening",
          "FIXTURE:ready",
          "shutdown_initiated",
          "FIXTURE:server_closed",
          "FIXTURE:redis_done",
          "FIXTURE:db_done",
          "shutdown_finalized",
        ],
        0,
        "sigterm",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("SIGTERM");
      expect(eventOf(r, "shutdown_initiated")?.data.finalExitCode).toBe(0);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(0);
    },
    20_000,
  );

  it(
    "fatal during shutdown escalates severity 0 -> 1 (never downgrades)",
    async () => {
      const r = await runFixture({
        mode: "escalation",
        env: { FIXTURE_REDIS: "slow" },
        signalOnMarker: "ready",
      });
      expectTrace(
        r,
        [
          "FIXTURE:listening",
          "FIXTURE:ready",
          "shutdown_initiated",
          "FIXTURE:server_closed",
          "FIXTURE:redis_start",
          "uncaught_exception",
          "shutdown_event_while_shutting_down",
          "FIXTURE:redis_done",
          "FIXTURE:db_done",
          "shutdown_finalized",
        ],
        1,
        "escalation",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.finalExitCode).toBe(0);
      expect(eventOf(r, "shutdown_event_while_shutting_down")?.data.finalExitCode).toBe(1);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "server close hangs -> deadline forces exit 1, no further cleanup",
    async () => {
      const r = await runFixture({
        mode: "hung_server",
        env: { FIXTURE_TIMEOUT_MS: "1500" },
        signalOnMarker: "ready",
      });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.slice(0, 3), "hung_server: prefix").toEqual([
        "FIXTURE:listening",
        "FIXTURE:ready",
        "shutdown_initiated",
      ]);
      expect(trace.includes("shutdown_timeout"), "hung_server: deadline fired").toBe(true);
      expect(trace.includes("FIXTURE:server_closed")).toBe(false);
      expect(trace.includes("FIXTURE:redis_done")).toBe(false);
      expect(trace.includes("FIXTURE:db_done")).toBe(false);
      expect(r.code, "hung_server: exit code").toBe(1);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "Redis cleanup hangs -> deadline forces exit 1 after server drain",
    async () => {
      const r = await runFixture({
        mode: "sigterm",
        env: { FIXTURE_REDIS: "hung", FIXTURE_TIMEOUT_MS: "1500" },
        signalOnMarker: "ready",
      });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.slice(0, 5), "hung_redis: prefix").toEqual([
        "FIXTURE:listening",
        "FIXTURE:ready",
        "shutdown_initiated",
        "FIXTURE:server_closed",
        "FIXTURE:redis_start",
      ]);
      expect(trace.includes("shutdown_timeout")).toBe(true);
      expect(trace.includes("FIXTURE:redis_done")).toBe(false);
      expect(trace.includes("FIXTURE:db_done")).toBe(false);
      expect(r.code, "hung_redis: exit code").toBe(1);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "Postgres cleanup hangs -> deadline forces exit 1 after server + redis",
    async () => {
      const r = await runFixture({
        mode: "sigterm",
        env: { FIXTURE_DB: "hung", FIXTURE_TIMEOUT_MS: "1500" },
        signalOnMarker: "ready",
      });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.slice(0, 6), "hung_db: prefix").toEqual([
        "FIXTURE:listening",
        "FIXTURE:ready",
        "shutdown_initiated",
        "FIXTURE:server_closed",
        "FIXTURE:redis_done",
        "FIXTURE:db_start",
      ]);
      expect(trace.includes("shutdown_timeout")).toBe(true);
      expect(trace.includes("FIXTURE:db_done")).toBe(false);
      expect(r.code, "hung_db: exit code").toBe(1);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "cleanup errors are logged but do not force non-zero exit",
    async () => {
      const r = await runFixture({
        mode: "sigterm",
        env: { FIXTURE_REDIS: "fail", FIXTURE_DB: "fail" },
        signalOnMarker: "ready",
      });
      const cleanupErrors = r.events.filter((e) => e.message === "shutdown_cleanup_error");
      expect(cleanupErrors, "redis-fail/db-fail: two cleanup errors").toHaveLength(2);
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.slice(-2), "redis-fail/db-fail: tail").toEqual([
        "shutdown_cleanup_error",
        "shutdown_finalized",
      ]);
      expect(r.code, "redis-fail/db-fail: exit code").toBe(0);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(0);
    },
    20_000,
  );

  it(
    "fatal before any server is created still runs registered cleanup",
    async () => {
      const r = await runFixture({ mode: "early_fatal" });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.includes("FIXTURE:listening")).toBe(false);
      expect(trace.includes("FIXTURE:server_closed")).toBe(false);
      expectTrace(
        r,
        ["FIXTURE:ready", "uncaught_exception", "shutdown_initiated", "FIXTURE:redis_done", "shutdown_finalized"],
        1,
        "early_fatal",
      );
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "SIGTERM during startup cancels delayed startup continuation (exit 0)",
    async () => {
      const r = await runFixture({
        mode: "sigterm_startup",
        env: { FIXTURE_STARTUP_MS: "300" },
        signalOnMarker: "ready_startup_paused",
      });
      expectTrace(
        r,
        [
          "FIXTURE:startup_begin",
          "FIXTURE:ready_startup_paused",
          "shutdown_initiated",
          "FIXTURE:startup_cancelled",
          "FIXTURE:guard_cleanup_done",
          "shutdown_finalized",
        ],
        0,
        "sigterm_startup",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("SIGTERM");
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(0);
    },
    20_000,
  );

  it(
    "pending listen is closed cleanly and never reaches listening",
    async () => {
      const r = await runFixture({ mode: "pending_listen" });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.includes("FIXTURE:listening")).toBe(false);
      expectTrace(
        r,
        [
          "shutdown_initiated",
          "FIXTURE:server_closed",
          "FIXTURE:redis_done",
          "FIXTURE:db_done",
          "shutdown_finalized",
        ],
        1,
        "pending_listen",
      );
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("PENDING_LISTEN_PROBE");
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "fatal after ready in signal mode still drives exit 1",
    async () => {
      const r = await runFixture({ mode: "sigterm", env: { FIXTURE_FATAL: "1" } });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.slice(0, 3), "fatal_after_ready: prefix").toEqual([
        "FIXTURE:listening",
        "FIXTURE:ready",
        "uncaught_exception",
      ]);
      expect(r.code, "fatal_after_ready: exit code").toBe(1);
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(1);
    },
    20_000,
  );

  it(
    "graceful finalize then late fatal before actual exit escalates pending exit 0 -> 1",
    async () => {
      const r = await runFixture({ mode: "late_fatal", signalOnMarker: "ready" });
      const trace = r.events.map((e) => e.message).filter(isKey);
      // Graceful path ran to completion first.
      expect(trace.slice(0, 7), "late_fatal: graceful prefix").toEqual([
        "FIXTURE:listening",
        "FIXTURE:ready",
        "shutdown_initiated",
        "FIXTURE:server_closed",
        "FIXTURE:redis_done",
        "FIXTURE:db_done",
        "shutdown_finalized",
      ]);
      // Then the late fatal is logged and escalates the pending exit.
      expect(trace.slice(-2), "late_fatal: escalation tail").toEqual([
        "uncaught_exception",
        "shutdown_fatal_after_finalize",
      ]);
      const finals = r.events.filter((e) => e.message === "shutdown_finalized");
      expect(finals, "late_fatal: once-only finalize").toHaveLength(1);
      expect(finals[0]?.data.exitCode, "late_fatal: graceful finalize logged 0").toBe(0);
      expect(r.code, "late_fatal: real exit escalated to 1").toBe(1);
    },
    20_000,
  );

  it(
    "shutdown during delayed seed import suppresses seed side effect and ws/listen",
    async () => {
      const r = await runFixture({
        mode: "seed_import",
        env: { FIXTURE_REDIS: "slow", FIXTURE_SEED_DELAY_MS: "600" },
        signalOnMarker: "seed_import_pending",
      });
      const trace = r.events.map((e) => e.message).filter(isKey);
      expect(trace.includes("FIXTURE:seed_module_loaded"), "seed_import: import resolved").toBe(
        true,
      );
      expect(trace.includes("FIXTURE:seed_guard_triggered"), "seed_import: guard fired").toBe(
        true,
      );
      expect(trace.includes("FIXTURE:seed_ran"), "seed_import: seed side effect ran").toBe(false);
      expect(trace.includes("FIXTURE:seed_called"), "seed_import: seed fn called").toBe(false);
      expect(trace.includes("FIXTURE:listening"), "seed_import: listen reached").toBe(false);
      expect(trace.includes("shutdown_initiated"), "seed_import: shutdown began").toBe(true);
      expect(trace.includes("shutdown_finalized"), "seed_import: finalized").toBe(true);
      expect(r.code, "seed_import: graceful exit code").toBe(0);
      expect(eventOf(r, "shutdown_initiated")?.data.reason).toBe("SIGTERM");
      expect(eventOf(r, "shutdown_finalized")?.data.exitCode).toBe(0);
    },
    20_000,
  );
});
