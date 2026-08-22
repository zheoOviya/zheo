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
  published: string[] = [];
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
  override async publish(channel: string, message: string): Promise<number> {
    this.published.push(message);
    return 1;
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

  it("does not re-dispatch a self-origin loopback (origin-based filter)", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const envelope = createEventEnvelope("OrderCreated", "order-1", {});
    await emit(envelope);
    // Replay the exact wire payload this instance published (its own echo).
    sub.simulateInbound("snakzap:events", sub.published.at(-1) as string);
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("suppresses a self-origin loopback even after >10_000 intervening emits (no memory window)", async () => {
    // The 10k emit loop writes one log line per event; silence the logger so
    // the test stays deterministic under the default 5s test timeout.
    vi.spyOn(logger, "info").mockImplementation((() => {}) as never);
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;

    const a = createEventEnvelope("OrderCreated", "event-A", {});
    await emit(a);
    const aWire = sub.published.at(-1) as string; // the exact payload Redis carries

    for (let i = 0; i < 10_001; i++) {
      await emit(createEventEnvelope("OrderCreated", `inter-${i}`, {}));
    }

    // A's own loop-back arrives only now; origin filtering must suppress it
    // regardless of how many other events were emitted in between.
    sub.simulateInbound("snakzap:events", aWire);
    await new Promise((r) => setTimeout(r, 10));

    const aCalls = handler.mock.calls.filter(
      (c) => c[0].aggregate_id === "event-A",
    );
    expect(aCalls).toHaveLength(1);
  });

  it("delivers a remote-instance event exactly once", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const remote = createEventEnvelope("OrderCreated", "order-remote", {});
    sub.simulateInbound(
      "snakzap:events",
      JSON.stringify({ origin_instance_id: "instance-B", event: remote }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].aggregate_id).toBe("order-remote");
  });

  it("defines the same event_id from two different instances as two independent deliveries", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const local = createEventEnvelope("OrderCreated", "dup-id", {});
    await emit(local); // local dispatch #1
    const selfWire = sub.published.at(-1) as string;
    // A different instance publishes a copy carrying the SAME event_id.
    const remoteWire = JSON.stringify({
      origin_instance_id: "instance-B",
      event: { ...local },
    });
    sub.simulateInbound("snakzap:events", selfWire); // self echo -> ignored
    sub.simulateInbound("snakzap:events", remoteWire); // remote copy -> dispatched
    await new Promise((r) => setTimeout(r, 10));
    const calls = handler.mock.calls.filter((c) => c[0].aggregate_id === "dup-id");
    // Explicit semantics: suppression is origin-scoped; the remote copy of the
    // same event_id is an independent delivery.
    expect(calls).toHaveLength(2);
  });

  it("accepts legacy raw envelopes from older publishers (backward compatibility)", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const legacy = createEventEnvelope("OrderCreated", "order-legacy", {});
    sub.simulateInbound("snakzap:events", JSON.stringify(legacy));
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].aggregate_id).toBe("order-legacy");
  });

  it("still dispatches locally on emit (in-process dispatch is unchanged)", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await emit(createEventEnvelope("OrderCreated", "order-1", {}));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not mutate event metadata during self-origin suppression", async () => {
    const handler = vi.fn();
    onEvent("OrderCreated", handler);
    await initEventSubscriber();
    const sub = getRedis().duplicate() as unknown as FakePubSub;
    const envelope = createEventEnvelope(
      "OrderCreated",
      "order-meta",
      { x: 1 },
      { trace_id: "t-1" },
    );
    await emit(envelope);
    sub.simulateInbound("snakzap:events", sub.published.at(-1) as string);
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
});
