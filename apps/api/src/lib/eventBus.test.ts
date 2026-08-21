import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventEnvelope,
  emit,
  initEventSubscriber,
  onEvent,
  resetEventBusForTests,
} from "./eventBus";
import { MemoryRedis, getRedis, resetRedisForTests, setRedisForTests } from "./redis";
import { logger } from "./logger";

class FakePubSub extends MemoryRedis {
  subscribed = false;
  messageHandlers: Array<(channel: string, message: string) => void> = [];
  override async subscribe(channel: string): Promise<void> {
    this.subscribed = true;
    return Promise.resolve();
  }
  override on(event: string, listener: (...args: unknown[]) => void) {
    if (event === "message") {
      this.messageHandlers.push(listener as (c: string, m: string) => void);
    }
    return this;
  }
  duplicate(): FakePubSub {
    return this;
  }
  simulateInbound(channel: string, message: string): void {
    for (const h of this.messageHandlers) h(channel, message);
  }
}

describe("eventBus", () => {
  beforeEach(() => {
    setRedisForTests(new FakePubSub());
    resetEventBusForTests();
  });
  afterEach(() => {
    resetEventBusForTests();
    resetRedisForTests();
    vi.restoreAllMocks();
  });

  it("subscribes on a duplicated connection and registers an on('message') handler (not the shared client)", async () => {
    const client = getRedis();
    const dupSpy = vi.spyOn(client, "duplicate");
    await initEventSubscriber();
    expect(dupSpy).toHaveBeenCalled();
    const sub = client.duplicate() as unknown as FakePubSub;
    expect(sub.subscribed).toBe(true);
    expect(sub.messageHandlers.length).toBeGreaterThan(0);
  });

  it("does not re-dispatch an event this instance already emitted (self-origin filter)", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const client = getRedis();
    const sub = client.duplicate() as unknown as FakePubSub;
    const envelope = createEventEnvelope("OrderCreated", "order-1", {});
    await emit(envelope);
    // Simulate the same instance receiving its own broadcast back.
    sub.simulateInbound("snakzap:events", JSON.stringify(envelope));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("delivers remote events received over the subscribed channel", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const client = getRedis();
    const sub = client.duplicate() as unknown as FakePubSub;
    const remote = createEventEnvelope("OrderCreated", "order-remote", {});
    sub.simulateInbound("snakzap:events", JSON.stringify(remote));
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].aggregate_id).toBe("order-remote");
  });

  it("still dispatches locally on emit (in-process dispatch is unchanged)", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await emit(createEventEnvelope("OrderCreated", "order-1", {}));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not mutate event metadata during self-origin filtering", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const client = getRedis();
    const sub = client.duplicate() as unknown as FakePubSub;
    const envelope = createEventEnvelope(
      "OrderCreated",
      "order-meta",
      { x: 1 },
      { trace_id: "t-1" },
    );
    await emit(envelope);
    sub.simulateInbound("snakzap:events", JSON.stringify(envelope));
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].event_id).toBe(envelope.event_id);
    expect(handler.mock.calls[0]![0].metadata).toEqual({ trace_id: "t-1" });
  });

  it("ignores messages published on other channels", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    sub.simulateInbound(
      "other:channel",
      JSON.stringify(createEventEnvelope("OrderCreated", "order-other", {})),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it("tolerates malformed payloads without crashing the subscriber", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    expect(() => sub.simulateInbound("snakzap:events", "not-json")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it("still dispatches locally when Redis publish fails (graceful degradation)", async () => {
    const broken: FakePubSub = new FakePubSub();
    vi.spyOn(broken, "publish").mockImplementation(() => {
      throw new Error("redis connection refused");
    });
    setRedisForTests(broken);
    resetEventBusForTests();
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await expect(
      emit(createEventEnvelope("OrderCreated", "order-down", {})),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("bounded dedup: after 10_000 distinct emits an old event_id is no longer suppressed", async () => {
    // The 10k emit loop writes one log line per event; silence the logger so
    // the test stays deterministic under the default 5s test timeout.
    vi.spyOn(logger, "info").mockImplementation((() => {}) as never);
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const first = createEventEnvelope("OrderCreated", "order-first", {});
    await emit(first);
    for (let i = 0; i < 10_000; i++) {
      await emit(createEventEnvelope("OrderCreated", `order-${i}`, {}));
    }
    // first id was evicted by the prune at >10_000 entries, so a looped-back
    // copy is treated as remote and dispatched again (memory stays bounded).
    sub.simulateInbound("snakzap:events", JSON.stringify(first));
    await new Promise((r) => setTimeout(r, 10));
    const firstCalls = handler.mock.calls.filter(
      (c) => c[0].aggregate_id === "order-first",
    );
    expect(firstCalls.length).toBe(2);
  });
});
