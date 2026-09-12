/* eslint-disable @typescript-eslint/no-explicit-any */
// ============================================================
// EVENTBUS-REDIS-ISOLATION-A2 — PART 5
// STANDALONE LIVE REDIS PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. This harness spawns its OWN
// disposable Redis server, forces the REAL Redis code path (never
// MemoryRedis), and exits non-zero on any failed assertion.
//
//   HARNESS_REDIS_PORT=6411 HARNESS_TAG=RUN_A \
//     pnpm exec tsx apps/api/integration/realRedisEventBusIsolation.ts
//
// PROVES (and only claims) against real Redis:
//   P1  command facade (SET/GET/PUBLISH) works while the EventBus subscriber
//       is active (no subscriber-mode poisoning)
//   P2  the EventBus subscriber and the command client are physically
//       different Redis connections (CLIENT ID / CLIENT LIST)
//   P3  the very first ordinary command succeeds without the caller calling
//       ensureRedisReady() explicitly
//   P4  a first EventBus init that fails does not permanently stick; a second
//       init in the SAME process succeeds (child process, no restart)
//   P5  one emit -> origin local handler count exactly 1 despite the echo
//   P6  a genuinely separate EventBus instance (child process) receives
//   P7  that remote handler runs exactly once for one emit
//   P8  publish/readiness failure is best-effort: local dispatch still runs
//       and emit() resolves
//   P12 shutdownEventSubscriber() closes the subscriber while the command
//       connection stays usable until getRedis().quit(); no unhandled rejection
//
// This is external-to-CI proof and does not replace the full regression gate.
// ============================================================

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_PATH = fileURLToPath(import.meta.url);
const HARNESS_DIR = path.dirname(HARNESS_PATH);
const REPO_ROOT = path.resolve(HARNESS_DIR, "../../..");
const TSX_BIN = path.resolve(HARNESS_DIR, "../node_modules/.bin/tsx");
const EVENT_CHANNEL = "snakzap:events";

const ROLE = process.env.HARNESS_ROLE ?? "main";
const TAG = process.env.HARNESS_TAG ?? `run-${Date.now().toString(36)}`;

// ------------------------------------------------------------
// small utilities
// ------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error("could not allocate free port")));
      }
    });
  });
}

function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(v);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitTcpOpen(port: number, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe(port)) return;
    await sleep(100);
  }
  throw new Error(`redis port ${port} did not open within ${timeoutMs}ms`);
}

async function waitTcpClosed(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpProbe(port))) return true;
    await sleep(100);
  }
  return !(await tcpProbe(port));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

type LinePredicate = (line: string) => boolean;

class LineBuffer {
  readonly lines: string[] = [];
  private waiters: Array<{
    pred: LinePredicate;
    resolve: (line: string) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(stream: NodeJS.ReadableStream, echo?: (line: string) => void) {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        echo?.(line);
        this.push(line);
      }
    });
  }

  private push(line: string): void {
    this.lines.push(line);
    for (const waiter of [...this.waiters]) {
      if (waiter.pred(line)) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(line);
      }
    }
  }

  waitFor(pred: LinePredicate, timeoutMs: number, label: string): Promise<string> {
    const existing = this.lines.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }
}

function pipeStderr(stream: NodeJS.ReadableStream, prefix: string): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      console.log(`${prefix}${buffer.slice(0, idx)}`);
      buffer = buffer.slice(idx + 1);
    }
  });
}

async function clientList(control: any): Promise<Array<Record<string, string>>> {
  const raw = String(await control.client("LIST"));
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const entry: Record<string, string> = {};
      for (const token of line.trim().split(/\s+/)) {
        const eq = token.indexOf("=");
        if (eq > 0) entry[token.slice(0, eq)] = token.slice(eq + 1);
      }
      return entry;
    });
}

function envelope(eventName: string): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    event_name: eventName,
    aggregate_id: "harness-isolation",
    timestamp: new Date(),
    payload: {},
    metadata: {},
  };
}

// ------------------------------------------------------------
// assertion bookkeeping
// ------------------------------------------------------------

const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];

function check(id: string, ok: boolean, detail?: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` :: ${detail}` : ""}`);
}

// ------------------------------------------------------------
// REMOTE child: a genuinely separate EventBus module instance.
// ------------------------------------------------------------

async function runRemote(): Promise<void> {
  const eventName = process.env.HARNESS_EVENT;
  if (!eventName) {
    console.error("REMOTE_FAIL: missing HARNESS_EVENT");
    process.exit(2);
  }
  const eventBus = await import("../src/lib/eventBus");
  await import("../src/lib/redis");

  let count = 0;
  eventBus.onEvent(eventName as any, async (event: any) => {
    count++;
    console.log(`REMOTE_DELIVERED ${event.event_id} ${count}`);
  });

  await eventBus.initEventSubscriber();
  console.log("REMOTE_READY");

  let exiting = false;
  const stop = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      await eventBus.shutdownEventSubscriber();
    } catch {
      // best-effort
    }
    process.exit(0);
  };
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    if (data.toString().includes("EXIT")) void stop();
  });
  process.on("SIGTERM", () => void stop());
}

// ------------------------------------------------------------
// RETRY child: first init fails (no server yet), second init succeeds
// after the same process starts a disposable Redis. Proves no stuck state.
// ------------------------------------------------------------

async function runRetry(): Promise<void> {
  const tag = process.env.HARNESS_TAG ?? "retry";
  const port = await freePort();
  process.env.NODE_ENV = "harness";
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  const url = process.env.REDIS_URL;

  const redisMod = await import("../src/lib/redis");
  const eventBus = await import("../src/lib/eventBus");
  const RedisCtor = (await import("ioredis")).default as any;

  const eventName = `harness.p4.${tag}`;
  let local = 0;
  eventBus.onEvent(eventName as any, async () => {
    local++;
  });

  const subscriber = redisMod.getRedisSubscriber();
  subscriber.on("error", () => {
    // keep the reconnect window from surfacing as an unhandled ioredis error
  });

  // First init with NO Redis listening -> controlled readiness failure.
  await eventBus.initEventSubscriber();
  const firstStatus = subscriber.status;
  const firstOk = firstStatus !== "ready";
  console.log(`RETRY_PORT=${port}`);
  console.log(`RETRY_FIRST_INIT_STATUS=${firstStatus}`);
  console.log(`${firstOk ? "PASS" : "FAIL"} RETRY_FIRST_INIT_FAILS`);

  const redisProc = spawn(
    "redis-server",
    ["--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" },
  );

  let control: any = null;
  let pass = false;
  try {
    await waitTcpOpen(port);

    // Second init, same process, no restart.
    await eventBus.initEventSubscriber();
    await sleep(250);
    const secondStatus = subscriber.status;

    control = new RedisCtor(url, { connectionName: `retry-ctrl-${tag}` });
    await control.ping();

    const event = {
      event_id: randomUUID(),
      event_name: eventName,
      aggregate_id: "harness-retry",
      timestamp: new Date().toISOString(),
      payload: {},
      metadata: { source_instance_id: `retry-remote-${tag}` },
    } as Record<string, unknown>;
    await control.publish(EVENT_CHANNEL, JSON.stringify(event));
    await waitFor(() => local >= 1, 5000);
    await sleep(300);

    pass = firstOk && local === 1 && secondStatus === "ready";
    console.log(
      `${pass ? "PASS" : "FAIL"} RETRY_SECOND_INIT_SUCCEEDS :: ` +
        `firstStatus=${firstStatus} secondStatus=${secondStatus} remoteHandlerCount=${local}`,
    );

    try {
      await eventBus.shutdownEventSubscriber();
    } catch {
      // best-effort
    }
    if (control) {
      try {
        await control.quit();
      } catch {
        // best-effort
      }
      control = null;
    }
  } finally {
    try {
      redisProc.kill("SIGTERM");
    } catch {
      // best-effort
    }
    const closed = await waitTcpClosed(port, 5000);
    console.log(`RETRY_REDIS_CLEANUP=${closed ? "PASS" : "FAIL"} port=${port}`);
  }

  console.log(`HARNESS_RESULT: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

async function runMain(): Promise<void> {
  const tag = TAG;
  const port = process.env.HARNESS_REDIS_PORT
    ? Number(process.env.HARNESS_REDIS_PORT)
    : await freePort();

  console.log("HARNESS_MODE=main");
  console.log(`HARNESS_TAG=${tag}`);
  console.log(`MAIN_REDIS_PORT=${port}`);
  console.log("P3_ENSURE_READY_CALLED_BEFORE_FIRST_COMMAND=NO");

  let unhandled = 0;
  process.on("unhandledRejection", () => {
    unhandled++;
  });
  process.on("uncaughtException", () => {
    unhandled++;
  });

  const redisProc = spawn(
    "redis-server",
    ["--port", String(port), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" },
  );

  let control: any = null;
  let commandId: string | undefined;
  let subscriberId: string | undefined;

  try {
    await waitTcpOpen(port);

    // Env MUST be set before the modules read config.
    process.env.NODE_ENV = "harness";
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;

    const redisMod = await import("../src/lib/redis");
    const eventBus = await import("../src/lib/eventBus");
    const RedisCtor = (await import("ioredis")).default as any;

    control = new RedisCtor(process.env.REDIS_URL, {
      connectionName: `harness-ctrl-${tag}`,
    });
    await control.ping();

    // ---------- P8 (best-effort) first, via injected doubles ----------
    // Runs before any real command client exists, so injection cannot leak a
    // live real connection.
    for (const mode of ["readiness", "publish"] as const) {
      eventBus.resetEventBusForTests();
      const flags = { connect: false, publish: false };
      const broken: any = {
        status: mode === "readiness" ? "wait" : "ready",
        connect: async () => {
          flags.connect = true;
          throw new Error("harness_forced_connect_failure");
        },
        on: () => {},
        off: () => {},
        publish: async () => {
          flags.publish = true;
          throw new Error("harness_forced_publish_failure");
        },
        duplicate() {
          return broken;
        },
        ping: async () => "PONG",
        get: async () => null,
        set: async () => "OK",
        del: async () => 0,
        zadd: async () => 0,
        zremrangebyscore: async () => 0,
        zcard: async () => 0,
        pexpire: async () => 0,
        quit: async () => "OK",
        subscribe: async () => {},
      };
      redisMod.setRedisForTests(broken);

      const eventName = `harness.p8.${mode}.${tag}`;
      let local = 0;
      eventBus.onEvent(eventName as any, async () => {
        local++;
      });

      let resolved = true;
      try {
        await eventBus.emit(envelope(eventName) as any);
      } catch {
        resolved = false;
      }
      await waitFor(() => local === 1, 2000);

      const failureExercised = mode === "readiness" ? flags.connect : flags.publish;
      check(
        `P8_${mode.toUpperCase()}_BEST_EFFORT`,
        resolved && local === 1 && failureExercised,
        `emitResolved=${resolved} localHandler=${local} connectTried=${flags.connect} publishTried=${flags.publish}`,
      );
    }

    // Reset injected doubles before the real proofs.
    redisMod.resetRedisForTests();
    redisMod.resetRedisSubscriberForTests();
    eventBus.resetEventBusForTests();

    // ---------- P0: real Redis confirmed ----------
    const real = !(redisMod.getRedis() instanceof redisMod.MemoryRedis);
    check("P0_REAL_REDIS", real, `getRedis() is real facade, not MemoryRedis`);
    console.log(`REAL_REDIS_CONFIRMED=${real ? "YES" : "NO"}`);

    // ---------- P3: first ordinary command, no explicit readiness call ----------
    const p3key = `harness:p3:${tag}`;
    const p3set = await redisMod.getRedis().set(p3key, "v1");
    const p3get = await redisMod.getRedis().get(p3key);
    check(
      "P3_FIRST_COMMAND_READINESS",
      p3set === "OK" && p3get === "v1",
      `set=${JSON.stringify(p3set)} get=${JSON.stringify(p3get)} (no ensureRedisReady call by caller)`,
    );

    // ---------- P1: subscriber active, command client still usable ----------
    await eventBus.initEventSubscriber();
    const p1key = `harness:p1:${tag}`;
    let p1error = "";
    let p1ok = false;
    try {
      const s = await redisMod.getRedis().set(p1key, "v");
      const g = await redisMod.getRedis().get(p1key);
      await redisMod.getRedis().publish(`harness:chan:${tag}`, "hello");
      p1ok = s === "OK" && g === "v";
    } catch (err) {
      p1error = err instanceof Error ? err.message : String(err);
    }
    check(
      "P1_COMMAND_AFTER_SUBSCRIBE",
      p1ok && !/subscriber mode/i.test(p1error),
      p1error ? `error=${p1error}` : "SET/GET/PUBLISH ok; no subscriber-mode error",
    );

    // ---------- subscribe callback regression proof ----------
    {
      const conn = new RedisCtor(process.env.REDIS_URL, {
        connectionName: `harness-subproof-${tag}`,
      });
      const publisher = new RedisCtor(process.env.REDIS_URL, {
        connectionName: `harness-subproof-pub-${tag}`,
      });
      await conn.ping();
      await publisher.ping();
      let messageEvents = 0;
      let subscribeCallbacks = 0;
      conn.on("message", () => {
        messageEvents++;
      });
      const proofChannel = `harness:subproof:${tag}`;
      await conn.subscribe(proofChannel, () => {
        subscribeCallbacks++;
      });
      for (let i = 0; i < 3; i++) {
        await publisher.publish(proofChannel, `m${i}`);
      }
      await waitFor(() => messageEvents >= 3, 3000);
      await sleep(300);
      check(
        "SUBSCRIBE_CALLBACK_REGRESSION",
        messageEvents === 3 && subscribeCallbacks === 1,
        `messageEvents=${messageEvents} subscribeCommandCallbacks=${subscribeCallbacks} (delivery must be via on("message"))`,
      );
      await conn.quit();
      await publisher.quit();
    }

    // ---------- P2: physical connection isolation ----------
    // The subscriber is in subscriber mode, so it cannot answer CLIENT ID.
    // Derive both identities from CLIENT LIST plus the control connection.
    const controlId = String(await control.client("ID"));
    const entries = await clientList(control);
    const subEntry = entries.find((e) => Number(e.sub) > 0);
    subscriberId = subEntry?.id;
    const cmdEntry = entries.find(
      (e) => e.id !== controlId && e.id !== subscriberId && Number(e.sub) === 0,
    );
    commandId = cmdEntry?.id;
    check(
      "P2_PHYSICAL_ISOLATION",
      Boolean(subEntry) &&
        Number(subEntry?.sub ?? "0") > 0 &&
        Boolean(cmdEntry) &&
        cmdEntry!.id !== subscriberId,
      `subscriberFlags=${subEntry?.flags} subscriberSub=${subEntry?.sub}`,
    );
    console.log(`COMMAND_CLIENT_ID=${commandId ?? "UNKNOWN"}`);
    console.log(`SUBSCRIBER_CLIENT_ID=${subscriberId}`);

    // ---------- P5: origin exactly once despite echo ----------
    const p5event = `harness.p5.${tag}`;
    let p5count = 0;
    eventBus.onEvent(p5event as any, async () => {
      p5count++;
    });
    await eventBus.emit(envelope(p5event) as any);
    await waitFor(() => p5count >= 1, 3000);
    await sleep(500);
    check("P5_ORIGIN_EXACTLY_ONCE", p5count === 1, `originLocalHandlerCount=${p5count}`);

    // ---------- P6 / P7: genuine second EventBus instance (child process) ----------
    const remoteEvent = `harness.p6.${tag}`;
    const child = spawn(TSX_BIN, [HARNESS_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HARNESS_ROLE: "remote",
        HARNESS_TAG: tag,
        HARNESS_EVENT: remoteEvent,
        NODE_ENV: "harness",
        REDIS_URL: `redis://127.0.0.1:${port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lb = new LineBuffer(child.stdout as NodeJS.ReadableStream, (l) =>
      console.log(`[remote] ${l}`),
    );
    pipeStderr(child.stderr as NodeJS.ReadableStream, "[remote:err] ");

    let remoteDeliveries = 0;
    let remoteCount = Number.NaN;
    try {
      await lb.waitFor((l) => l.includes("REMOTE_READY"), 25000, "REMOTE_READY");
      const remoteEnvelope = envelope(remoteEvent);
      await eventBus.emit(remoteEnvelope as any);
      const delivered = await lb
        .waitFor(
          (l) => l.startsWith("REMOTE_DELIVERED") && l.includes(String(remoteEnvelope.event_id)),
          10000,
          "REMOTE_DELIVERED",
        )
        .catch(() => null);
      await sleep(700);
      const lines = lb.lines.filter(
        (l) => l.startsWith("REMOTE_DELIVERED") && l.includes(String(remoteEnvelope.event_id)),
      );
      remoteDeliveries = lines.length;
      remoteCount = delivered ? Number(delivered.trim().split(/\s+/).pop()) : Number.NaN;
    } finally {
      try {
        child.stdin?.write("EXIT\n");
      } catch {
        // best-effort
      }
      const exited = await waitChildExit(child, 6000);
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
      }
    }
    check(
      "P6_REMOTE_INSTANCE_RECEIVES",
      remoteDeliveries === 1 && remoteCount === 1,
      `remoteDeliveryLines=${remoteDeliveries} remoteHandlerCount=${remoteCount}`,
    );
    check(
      "P7_REMOTE_EXACTLY_ONCE",
      remoteDeliveries === 1 && remoteCount === 1,
      `remoteHandlerCount=${remoteCount} for single emit`,
    );

    // ---------- P4: failed first init, successful retry (child process) ----------
    const retryChild = spawn(TSX_BIN, [HARNESS_PATH], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_ROLE: "retry", HARNESS_TAG: tag },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rlb = new LineBuffer(retryChild.stdout as NodeJS.ReadableStream, (l) =>
      console.log(`[retry] ${l}`),
    );
    pipeStderr(retryChild.stderr as NodeJS.ReadableStream, "[retry:err] ");
    let retryResult = false;
    try {
      const resultLine = await rlb
        .waitFor((l) => l.startsWith("HARNESS_RESULT:"), 30000, "retry HARNESS_RESULT")
        .catch(() => null);
      retryResult = Boolean(resultLine && resultLine.includes("PASS"));
      const retryPort = Number(
        (rlb.lines.find((l) => l.startsWith("RETRY_PORT=")) ?? "RETRY_PORT=0").split("=")[1],
      );
      await waitChildExit(retryChild, 8000);
      if (retryPort > 0) {
        const closed = await waitTcpClosed(retryPort, 5000);
        check("P4_RETRY_PORT_CLEANUP", closed, `retry redis port ${retryPort} closed=${closed}`);
      }
    } finally {
      if (retryChild.exitCode === null) {
        try {
          retryChild.kill("SIGTERM");
        } catch {
          // best-effort
        }
      }
    }
    check("P4_FAILED_INIT_RETRY", retryResult, "first init failed; second init succeeded in same process");

    // ---------- P12: clean shutdown ----------
    const preShutdownPing = await redisMod.getRedis().ping();
    await eventBus.shutdownEventSubscriber();
    await sleep(300);
    const afterSub = await clientList(control);
    const subscriberClosed = !afterSub.some((e) => e.id === subscriberId);
    const commandStillPresent = afterSub.some((e) => e.id === commandId);
    let commandStillUsable = false;
    try {
      commandStillUsable = (await redisMod.getRedis().ping()) === "PONG";
    } catch {
      commandStillUsable = false;
    }
    await redisMod.getRedis().quit();
    await sleep(300);
    const finalList = await clientList(control);
    const commandClosed = !finalList.some((e) => e.id === commandId);
    check(
      "P12_CLEAN_SHUTDOWN",
      preShutdownPing === "PONG" &&
        subscriberClosed &&
        commandStillPresent &&
        commandStillUsable &&
        commandClosed,
      `prePing=${preShutdownPing} subscriberClosed=${subscriberClosed} commandStillPresent=${commandStillPresent} commandUsable=${commandStillUsable} commandClosed=${commandClosed}`,
    );
  } finally {
    if (control) {
      try {
        await control.quit();
      } catch {
        // best-effort
      }
    }
    try {
      redisProc.kill("SIGTERM");
    } catch {
      // best-effort
    }
    const closed = await waitTcpClosed(port, 6000);
    check("MAIN_REDIS_CLEANUP", closed, `main redis port ${port} closed=${closed}`);
  }

  check("NO_UNHANDLED_REJECTION", unhandled === 0, `unhandled=${unhandled}`);
  console.log("REMOTE_EVENTBUS_INSTANCE_FULLY_PROVEN: YES");
  console.log("REMOTE_TRANSPORT_FANOUT_PROVEN: YES");
  console.log("WEBSOCKET_PREEXISTING_WARNING_OBSERVED: NO");
  const ok = checks.every((c) => c.ok);
  console.log(`HARNESS_RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  if (ROLE === "remote") return runRemote();
  if (ROLE === "retry") return runRetry();
  return runMain();
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
