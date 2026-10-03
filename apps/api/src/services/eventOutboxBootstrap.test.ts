import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEventOutboxRelayIntervalMs } from "../config";
import {
  EVENT_OUTBOX_RELAY_INTERVAL_MS,
  type EventOutboxRelayTickResult,
  type EventOutboxRelay,
  isEventOutboxRelayRunning,
  resolveEventOutboxRelayIntervalMs,
  startEventOutboxRelay,
  stopEventOutboxRelay,
} from "./eventOutboxRelay";

// ============================================
// EVT-RELAY-BOOTSTRAP lifecycle semantics.
//
// These pin the production bootstrap contract: idempotent start, one immediate
// boot tick, bounded periodic ticks, overlap suppression, stop prevents new
// ticks, and stop awaits an in-flight tick. Delivery semantics (AT_LEAST_ONCE,
// stable event_id) are unchanged and covered by eventOutboxRelay.test.ts.
//
// Real timers with short intervals are used so the tests exercise the actual
// setInterval/clearInterval wiring deterministically.
// ============================================

const EMPTY: EventOutboxRelayTickResult = {
  claimed: 0,
  published: 0,
  retried: 0,
  deadLettered: 0,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function stubRelay(
  tick: () => Promise<EventOutboxRelayTickResult>,
): EventOutboxRelay {
  return { tick } as unknown as EventOutboxRelay;
}

describe("startEventOutboxRelay lifecycle (EVT-RELAY-BOOTSTRAP)", () => {
  afterEach(async () => {
    await stopEventOutboxRelay();
  });

  it("R-BOOT-1 boots immediately then ticks on the interval", async () => {
    const tick = vi.fn(async () => EMPTY);
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 15 });

    // Boot tick is synchronous with start().
    expect(tick).toHaveBeenCalledTimes(1);

    await sleep(70);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("R-BOOT-2 is idempotent while running", async () => {
    const first = vi.fn(async () => EMPTY);
    const second = vi.fn(async () => EMPTY);

    startEventOutboxRelay({ relay: stubRelay(first), intervalMs: 15 });
    startEventOutboxRelay({ relay: stubRelay(second), intervalMs: 15 });

    await sleep(50);
    expect(first.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(second).not.toHaveBeenCalled();
  });

  it("R-BOOT-3 suppresses overlapping ticks while one is in flight", async () => {
    let resolveTick!: (result: EventOutboxRelayTickResult) => void;
    const tick = vi.fn(
      () => new Promise<EventOutboxRelayTickResult>((r) => (resolveTick = r)),
    );

    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 10 });
    expect(tick).toHaveBeenCalledTimes(1);

    // Several intervals elapse while the first tick is still in flight.
    await sleep(60);
    expect(tick).toHaveBeenCalledTimes(1);

    resolveTick(EMPTY);
    await sleep(25);
    expect(tick).toHaveBeenCalledTimes(2);

    // Settle the second (now in-flight) tick so stop() can complete.
    resolveTick(EMPTY);
    await sleep(5);
  });

  it("R-BOOT-4 stop prevents further ticks", async () => {
    const tick = vi.fn(async () => EMPTY);
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 10 });
    await sleep(30);

    await stopEventOutboxRelay();
    expect(isEventOutboxRelayRunning()).toBe(false);
    const afterStop = tick.mock.calls.length;

    await sleep(40);
    expect(tick.mock.calls.length).toBe(afterStop);
  });

  it("R-BOOT-5 stop awaits an in-flight tick", async () => {
    let resolveTick!: (result: EventOutboxRelayTickResult) => void;
    const tick = vi.fn(
      () => new Promise<EventOutboxRelayTickResult>((r) => (resolveTick = r)),
    );

    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 10 });
    await sleep(15);

    let settled = false;
    const stopping = stopEventOutboxRelay().then(() => {
      settled = true;
    });
    await sleep(20);
    expect(settled).toBe(false);

    resolveTick(EMPTY);
    await stopping;
    expect(settled).toBe(true);
  });

  it("R-BOOT-6 can restart after stop", async () => {
    const tick = vi.fn(async () => EMPTY);
    const relay = stubRelay(tick);

    startEventOutboxRelay({ relay, intervalMs: 10 });
    await sleep(30);
    const afterFirst = tick.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    await stopEventOutboxRelay();

    startEventOutboxRelay({ relay, intervalMs: 10 });
    await sleep(30);
    expect(tick.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("R-BOOT-7 requires a relay or a repo", () => {
    expect(() => startEventOutboxRelay()).toThrow();
  });
});

describe("relay interval config (EVT-RELAY-BOOTSTRAP)", () => {
  it("R-CFG-1 parses a positive integer", () => {
    expect(parseEventOutboxRelayIntervalMs("2500")).toBe(2500);
    expect(parseEventOutboxRelayIntervalMs("1")).toBe(1);
  });

  it("R-CFG-2 treats unset/blank as the bounded default", () => {
    expect(parseEventOutboxRelayIntervalMs(undefined)).toBeNull();
    expect(parseEventOutboxRelayIntervalMs("")).toBeNull();
    expect(parseEventOutboxRelayIntervalMs("   ")).toBeNull();
  });

  it("R-CFG-3 fails closed on invalid values", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "NaN", "1e", " 10x "]) {
      expect(() => parseEventOutboxRelayIntervalMs(bad)).toThrow();
    }
  });

  it("R-CFG-4 resolves a positive cadence", () => {
    const resolved = resolveEventOutboxRelayIntervalMs();
    expect(Number.isInteger(resolved)).toBe(true);
    expect(resolved).toBeGreaterThan(0);
    expect(resolved).toBe(
      parseEventOutboxRelayIntervalMs(
        process.env.EVENT_OUTBOX_RELAY_INTERVAL_MS,
      ) ?? EVENT_OUTBOX_RELAY_INTERVAL_MS,
    );
  });
});
