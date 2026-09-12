import { beforeEach, describe, expect, it } from "vitest";
import {
  resetRedisForTests,
  resetRedisSubscriberForTests,
  setRedisForTests,
} from "./redis";
import type { RedisLike } from "./redis";
import {
  emit,
  getSourceInstanceIdForTests,
  initEventSubscriber,
  onEvent,
  resetEventBusForTests,
  shutdownEventSubscriber,
} from "./eventBus";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

const EVENT_CHANNEL = "snakzap:events";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSubscriber implements RedisLike {
  status = "ready";
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  quitCalls = 0;
  failSubscribeTimes = 0;

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  duplicate(): RedisLike {
    return this;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string): Promise<"OK"> {
    return "OK";
  }

  async del(..._keys: string[]): Promise<number> {
    return 0;
  }

  async zadd(_key: string, _score: number, _member: string): Promise<number> {
    return 0;
  }

  async zremrangebyscore(_key: string, _min: number, _max: number): Promise<number> {
    return 0;
  }

  async zcard(_key: string): Promise<number> {
    return 0;
  }

  async pexpire(_key: string, _ms: number): Promise<number> {
    return 0;
  }

  async quit(): Promise<"OK"> {
    this.quitCalls++;
    return "OK";
  }

  async publish(_channel: string, _message: string): Promise<number> {
    return 0;
  }

  async subscribe(
    _channel: string,
    _onMessage: (channel: string, message: string) => void,
  ): Promise<void> {
    this.subscribeCalls++;
    if (this.failSubscribeTimes > 0) {
      this.failSubscribeTimes--;
      throw new Error("forced_subscribe_failure");
    }
  }

  async unsubscribe(_channel: string): Promise<void> {
    this.unsubscribeCalls++;
  }
}

class FakeCommand implements RedisLike {
  status = "ready";
  published: string[] = [];
  publishShouldFail = false;
  connectShouldFail = false;
  quitCalls = 0;
  subscribeCalls = 0;
  readonly sub = new FakeSubscriber();

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  duplicate(): RedisLike {
    return this.sub;
  }

  async connect(): Promise<void> {
    if (this.connectShouldFail) throw new Error("forced_connect_failure");
    this.status = "ready";
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string): Promise<"OK"> {
    return "OK";
  }

  async del(..._keys: string[]): Promise<number> {
    return 0;
  }

  async zadd(_key: string, _score: number, _member: string): Promise<number> {
    return 0;
  }

  async zremrangebyscore(_key: string, _min: number, _max: number): Promise<number> {
    return 0;
  }

  async zcard(_key: string): Promise<number> {
    return 0;
  }

  async pexpire(_key: string, _ms: number): Promise<number> {
    return 0;
  }

  async quit(): Promise<"OK"> {
    this.quitCalls++;
    return "OK";
  }

  async publish(_channel: string, message: string): Promise<number> {
    if (this.publishShouldFail) throw new Error("forced_publish_failure");
    this.published.push(message);
    return 1;
  }

  async subscribe(): Promise<void> {
    this.subscribeCalls++;
    throw new Error("command_client_must_not_subscribe");
  }
}

function setup(command: FakeCommand): void {
  resetEventBusForTests();
  resetRedisForTests();
  resetRedisSubscriberForTests();
  setRedisForTests(command);
}

function makeEvent(
  eventName: EventName,
  metadata: Record<string, unknown> = {},
): TypedEventEnvelope<EventName> {
  return {
    event_id: "eut-event-id",
    event_name: eventName,
    aggregate_id: "discovery",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: { ok: true },
    metadata,
  } as unknown as TypedEventEnvelope<EventName>;
}

function deliver(command: FakeCommand, message: string): void {
  command.sub.emit("message", EVENT_CHANNEL, message);
}

describe("eventBus isolation + delivery (EVENTBUS-REDIS-ISOLATION)", () => {
  beforeEach(() => {
    resetEventBusForTests();
    resetRedisForTests();
    resetRedisSubscriberForTests();
  });

  it("EUT1: emit runs the local handler exactly once", async () => {
    const command = new FakeCommand();
    setup(command);

    let calls = 0;
    onEvent("EUT1_EVENT" as EventName, async () => {
      calls++;
    });

    await emit(makeEvent("EUT1_EVENT" as EventName));
    expect(calls).toBe(1);
  });

  it("EUT2: one throwing handler cannot block the others", async () => {
    const command = new FakeCommand();
    setup(command);

    let first = 0;
    let second = 0;
    onEvent("EUT2_EVENT" as EventName, async () => {
      first++;
      throw new Error("handler boom");
    });
    onEvent("EUT2_EVENT" as EventName, async () => {
      second++;
    });

    await expect(emit(makeEvent("EUT2_EVENT" as EventName))).resolves.toBeUndefined();
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("EUT3: publish/readiness failures are swallowed and local dispatch still runs", async () => {
    const command = new FakeCommand();
    setup(command);
    command.publishShouldFail = true;

    let calls = 0;
    onEvent("EUT3_EVENT" as EventName, async () => {
      calls++;
    });

    await expect(emit(makeEvent("EUT3_EVENT" as EventName))).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(command.published).toHaveLength(0);

    const unreachable = new FakeCommand();
    setup(unreachable);
    unreachable.status = "wait";
    unreachable.connectShouldFail = true;

    let readinessCalls = 0;
    onEvent("EUT3B_EVENT" as EventName, async () => {
      readinessCalls++;
    });

    await expect(
      emit(makeEvent("EUT3B_EVENT" as EventName)),
    ).resolves.toBeUndefined();
    expect(readinessCalls).toBe(1);
  });

  it("EUT4: forced source id is applied to the published copy only", async () => {
    const command = new FakeCommand();
    setup(command);

    const caller = makeEvent("EUT4_EVENT" as EventName, {
      source_instance_id: "caller-junk",
      keep: true,
    });

    await emit(caller);

    expect(command.published).toHaveLength(1);
    const published = JSON.parse(command.published[0] ?? "{}");
    expect(published.metadata.source_instance_id).toBe(getSourceInstanceIdForTests());
    expect(published.metadata.keep).toBe(true);
    expect(caller.metadata?.source_instance_id).toBe("caller-junk");
    expect(caller.metadata?.keep).toBe(true);
  });

  describe("subscriber delivery", () => {
    async function activate(command: FakeCommand): Promise<void> {
      setup(command);
      await initEventSubscriber();
    }

    it("EUT5: own echo (matching source_instance_id) is ignored", async () => {
      const command = new FakeCommand();
      await activate(command);

      let calls = 0;
      onEvent("EUT5_EVENT" as EventName, async () => {
        calls++;
      });

      deliver(
        command,
        JSON.stringify(
          makeEvent("EUT5_EVENT" as EventName, {
            source_instance_id: getSourceInstanceIdForTests(),
          }),
        ),
      );
      await tick();
      expect(calls).toBe(0);
    });

    it("EUT6: a remote-origin event is dispatched", async () => {
      const command = new FakeCommand();
      await activate(command);

      let calls = 0;
      onEvent("EUT6_EVENT" as EventName, async () => {
        calls++;
      });

      deliver(command, JSON.stringify(makeEvent("EUT6_EVENT" as EventName)));
      await tick();
      expect(calls).toBe(1);
    });

    it("EUT7: malformed JSON is ignored and a later valid event still dispatches", async () => {
      const command = new FakeCommand();
      await activate(command);

      let calls = 0;
      onEvent("EUT7_EVENT" as EventName, async () => {
        calls++;
      });

      deliver(command, "not-json{{{");
      await tick();
      deliver(command, JSON.stringify(makeEvent("EUT7_EVENT" as EventName)));
      await tick();
      expect(calls).toBe(1);
    });

    it("EUT8: invalid shape is ignored and a later valid event still dispatches", async () => {
      const command = new FakeCommand();
      await activate(command);

      let calls = 0;
      onEvent("EUT8_EVENT" as EventName, async () => {
        calls++;
      });

      deliver(command, JSON.stringify({ foo: 1 }));
      await tick();
      deliver(command, JSON.stringify(makeEvent("EUT8_EVENT" as EventName)));
      await tick();
      expect(calls).toBe(1);
    });

    it("EUT9: concurrent init shares one subscribe", async () => {
      const command = new FakeCommand();
      setup(command);

      await Promise.all([initEventSubscriber(), initEventSubscriber()]);
      expect(command.sub.subscribeCalls).toBe(1);
      expect(command.sub.listenerCount("message")).toBe(1);
    });

    it("EUT10: a failed first init is retryable without duplicate listeners", async () => {
      const command = new FakeCommand();
      setup(command);
      command.sub.failSubscribeTimes = 1;

      await initEventSubscriber();
      expect(command.sub.subscribeCalls).toBe(1);
      expect(command.sub.listenerCount("message")).toBe(0);

      await initEventSubscriber();
      expect(command.sub.subscribeCalls).toBe(2);
      expect(command.sub.listenerCount("message")).toBe(1);
    });

    it("EUT11: shutdown is idempotent and never closes the command client", async () => {
      const command = new FakeCommand();
      await activate(command);

      await shutdownEventSubscriber();
      await shutdownEventSubscriber();

      expect(command.sub.quitCalls).toBe(1);
      expect(command.quitCalls).toBe(0);
      await expect(command.get("k")).resolves.toBeNull();

      await initEventSubscriber();
      expect(command.sub.subscribeCalls).toBe(1);
    });

    it("EUT12: reset restores a fresh subscriber and self-skip still holds", async () => {
      const command = new FakeCommand();
      await activate(command);
      await shutdownEventSubscriber();
      expect(command.sub.subscribeCalls).toBe(1);

      resetEventBusForTests();
      resetRedisSubscriberForTests();
      await initEventSubscriber();
      expect(command.sub.subscribeCalls).toBe(2);

      let calls = 0;
      onEvent("EUT12_EVENT" as EventName, async () => {
        calls++;
      });
      deliver(
        command,
        JSON.stringify(
          makeEvent("EUT12_EVENT" as EventName, {
            source_instance_id: getSourceInstanceIdForTests(),
          }),
        ),
      );
      await tick();
      expect(calls).toBe(0);
    });
  });
});
