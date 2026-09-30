import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRedis, resetRedisForTests, setRedisForTests } from "./redis";
import {
  emit,
  onEvent,
  publishDurableEnvelope,
  resetEventBusForTests,
} from "./eventBus";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";

// ============================================
// EVT-C2 strict durable-publish seam.
//
// publishDurableEnvelope must surface BOTH handler failures and transport
// (Redis) failures as rejections so the outbox relay keeps the row for retry.
// emit() keeps its historical best-effort swallow so existing fire-and-forget
// subscribers are unaffected.
// ============================================

class FailingPublishRedis extends MemoryRedis {
  override async publish(): Promise<number> {
    throw new Error("c2.transport_down");
  }
}

function makeEvent(eventName: string): TypedEventEnvelope<EventName> {
  return {
    event_id: "11111111-1111-4111-8111-111111111111",
    event_name: eventName,
    aggregate_id: "c2-agg",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: { ok: true },
    metadata: {},
  } as unknown as TypedEventEnvelope<EventName>;
}

beforeEach(() => {
  resetEventBusForTests();
  resetRedisForTests();
});

describe("EVT-C2 publishDurableEnvelope strict semantics", () => {
  it("C2-BUS-1: a handler failure rejects publishDurableEnvelope", async () => {
    onEvent("C2_BUS_1" as EventName, async () => {
      throw new Error("c2.handler_boom");
    });
    await expect(
      publishDurableEnvelope(makeEvent("C2_BUS_1")),
    ).rejects.toThrow("c2.handler_boom");
  });

  it("C2-BUS-2: emit keeps swallowing a handler failure (unchanged)", async () => {
    let otherRan = false;
    onEvent("C2_BUS_2" as EventName, async () => {
      throw new Error("c2.handler_boom");
    });
    onEvent("C2_BUS_2" as EventName, async () => {
      otherRan = true;
    });
    await expect(emit(makeEvent("C2_BUS_2"))).resolves.toBeUndefined();
    expect(otherRan).toBe(true);
  });

  it("C2-BUS-3: a successful handler resolves publishDurableEnvelope", async () => {
    let ran = 0;
    onEvent("C2_BUS_3" as EventName, async () => {
      ran++;
    });
    await expect(
      publishDurableEnvelope(makeEvent("C2_BUS_3")),
    ).resolves.toBeUndefined();
    expect(ran).toBe(1);
  });

  it("C2-BUS-4: a transport failure rejects publishDurableEnvelope", async () => {
    setRedisForTests(new FailingPublishRedis());
    let ran = 0;
    onEvent("C2_BUS_4" as EventName, async () => {
      ran++;
    });
    await expect(
      publishDurableEnvelope(makeEvent("C2_BUS_4")),
    ).rejects.toThrow("c2.transport_down");
    expect(ran).toBe(1);
  });
});
