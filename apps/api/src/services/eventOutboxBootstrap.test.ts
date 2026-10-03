import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// Determinism: the lifecycle contract is a timer contract, so it is driven by
// VITEST FAKE TIMERS with explicit advancement. There are deliberately NO
// wall-clock sleeps, so CI CPU scheduling cannot change the outcome.
//
// Isolation: the relay bootstrap exposes module-global lifecycle state
// (relayInstance / relayTimer / inFlightTick). Every test starts from a known
// stopped relay and leaves it stopped. Deliberately-blocked (deferred) ticks are
// tracked in `pending` and ALWAYS settled in afterEach before stop(), so no
// unresolved promise can escape a test and afterEach never blocks on a tick the
// test intentionally suspended.
// ============================================

const EMPTY: EventOutboxRelayTickResult = {
  claimed: 0,
  published: 0,
  retried: 0,
  deadLettered: 0,
};

function stubRelay(
  tick: () => Promise<EventOutboxRelayTickResult>,
): EventOutboxRelay {
  return { tick } as unknown as EventOutboxRelay;
}

describe("startEventOutboxRelay lifecycle (EVT-RELAY-BOOTSTRAP)", () => {
  // Resolver queue for deliberately-blocked deferred ticks. Tracked at describe
  // scope so afterEach can settle every one of them, regardless of test outcome.
  const pending: Array<(result: EventOutboxRelayTickResult) => void> = [];

  const deferredTick = (): (() => Promise<EventOutboxRelayTickResult>) =>
    () =>
      new Promise<EventOutboxRelayTickResult>((resolve) => pending.push(resolve));

  beforeEach(async () => {
    vi.useFakeTimers();
    await stopEventOutboxRelay(); // guarantee a known stopped relay state
  });

  afterEach(async () => {
    // Settle any tick the test deliberately left blocked BEFORE stopping, so the
    // stop-await can never hang on an unresolved deferred promise.
    while (pending.length > 0) pending.pop()?.(EMPTY);
    await stopEventOutboxRelay();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("R-BOOT-1 boots immediately then ticks on the interval", async () => {
    const tick = vi.fn(async () => EMPTY);
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 1_000 });

    // Boot tick is synchronous with start().
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("R-BOOT-2 is idempotent while running", async () => {
    const first = vi.fn(async () => EMPTY);
    const second = vi.fn(async () => EMPTY);

    startEventOutboxRelay({ relay: stubRelay(first), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A second start while running is ignored; the original relay keeps ticking.
    startEventOutboxRelay({ relay: stubRelay(second), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(second).not.toHaveBeenCalled();
    expect(first.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("R-BOOT-3 suppresses overlapping ticks while one is in flight", async () => {
    const tick = vi.fn(deferredTick());
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 1_000 });
    expect(tick).toHaveBeenCalledTimes(1); // boot tick is in flight

    // Many intervals elapse while the first tick is still unsettled.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);

    pending.shift()?.(EMPTY); // settle the boot tick
    await vi.advanceTimersByTimeAsync(1_000); // next interval now invokes tick
    expect(tick).toHaveBeenCalledTimes(2);

    pending.shift()?.(EMPTY); // settle the second tick
    await vi.advanceTimersByTimeAsync(0);
  });

  it("R-BOOT-4 stop prevents further ticks", async () => {
    const tick = vi.fn(async () => EMPTY);
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(isEventOutboxRelayRunning()).toBe(true);

    await stopEventOutboxRelay();
    expect(isEventOutboxRelayRunning()).toBe(false);
    const afterStop = tick.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick.mock.calls.length).toBe(afterStop);
  });

  it("R-BOOT-5 stop awaits an in-flight tick", async () => {
    const tick = vi.fn(deferredTick());
    startEventOutboxRelay({ relay: stubRelay(tick), intervalMs: 1_000 });

    let settled = false;
    const stopping = stopEventOutboxRelay().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // stop is blocked on the in-flight tick

    pending.shift()?.(EMPTY);
    await stopping;
    expect(settled).toBe(true);
  });

  it("R-BOOT-6 can restart after stop", async () => {
    const tick = vi.fn(async () => EMPTY);
    const relay = stubRelay(tick);

    startEventOutboxRelay({ relay, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    const afterFirst = tick.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    await stopEventOutboxRelay();

    startEventOutboxRelay({ relay, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(3_000);
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
