import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import type { DineInOutboxEnqueuer } from "../repositories/dineInContracts";
import { mapDineInEventFacts } from "./dineInEventMapper";
import { enqueueDineInEventFacts } from "./dineInEventEmitter";
import type { DineInEventFact } from "./dineInSession";

// ------------------------------------------------------------
// EVT-B2B-NP3-B helper-level tests. The real enqueue helper runs against a
// fake tx-bound outbox — no Redis, no DB, no handlers, no eventBus.emit.
//
// The helper is the durable successor to D2.5C9.2 best-effort emission: each
// scoped fact becomes exactly one outbox row on the CALLER'S transaction.
// ------------------------------------------------------------

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const TABLE_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const BILL_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

const openedFact: DineInEventFact = {
  kind: "SESSION_OPENED",
  session_id: SESSION_ID,
  restaurant_id: RESTAURANT_ID,
  table_id: TABLE_ID,
  customer_user_id: CUSTOMER_ID,
};

const billFact: DineInEventFact = {
  kind: "BILL_REQUESTED",
  session_id: SESSION_ID,
  bill_id: BILL_ID,
  restaurant_id: RESTAURANT_ID,
  table_id: TABLE_ID,
  total_amount: 105,
};

const requestFact: DineInEventFact = {
  kind: "SERVICE_REQUEST_CREATED",
  request_id: REQUEST_ID,
  session_id: SESSION_ID,
  restaurant_id: RESTAURANT_ID,
  request_type: "BRING_BILL",
  request_status: "PENDING",
};

function fakeOutbox(): {
  outbox: DineInOutboxEnqueuer;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn(async (_envelope: TypedEventEnvelope<EventName>) => {});
  return { outbox: { enqueue } as unknown as DineInOutboxEnqueuer, enqueue };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueDineInEventFacts (EVT-B2B-NP3-B)", () => {
  it("D: enqueues exactly one row per fact on the supplied outbox", async () => {
    const { outbox, enqueue } = fakeOutbox();
    await enqueueDineInEventFacts([billFact, requestFact], "corr-rb", outbox);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const env0 = enqueue.mock.calls[0]![0] as TypedEventEnvelope<EventName>;
    const env1 = enqueue.mock.calls[1]![0] as TypedEventEnvelope<EventName>;
    expect(env0.metadata).toMatchObject({ correlation_id: "corr-rb" });
    expect(env1.metadata).toMatchObject({ correlation_id: "corr-rb" });
  });

  it("E: two requestBill envelopes have distinct event_id values", async () => {
    const { outbox, enqueue } = fakeOutbox();
    await enqueueDineInEventFacts([billFact, requestFact], "corr-rb", outbox);
    const env0 = enqueue.mock.calls[0]![0] as TypedEventEnvelope<EventName>;
    const env1 = enqueue.mock.calls[1]![0] as TypedEventEnvelope<EventName>;
    expect(env0.event_id).toBeDefined();
    expect(env1.event_id).toBeDefined();
    expect(env0.event_id).not.toBe(env1.event_id);
  });

  it("F: envelope timestamp is created at enqueue time, not a domain timestamp", async () => {
    const { outbox, enqueue } = fakeOutbox();
    const before = Date.now();
    await enqueueDineInEventFacts([billFact, requestFact], "corr-rb", outbox);
    const after = Date.now();
    const env0 = enqueue.mock.calls[0]![0] as TypedEventEnvelope<EventName>;
    expect(env0.timestamp).toBeInstanceOf(Date);
    const ts = env0.timestamp.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
    // Payload carries NO domain transition timestamps.
    const serialized = JSON.stringify(env0.payload);
    expect(serialized).not.toContain("created_at");
    expect(serialized).not.toContain("bill_requested_at");
    expect(serialized).not.toContain("requested_at");
  });

  it("N: enqueued names/payloads/aggregate ids match the C9.1 descriptors exactly", async () => {
    const { outbox, enqueue } = fakeOutbox();
    const facts = [billFact, requestFact];
    await enqueueDineInEventFacts(facts, "corr-rb", outbox);
    const descriptors = mapDineInEventFacts(facts, "corr-rb");
    expect(enqueue).toHaveBeenCalledTimes(descriptors.length);
    enqueue.mock.calls.forEach((call, i: number) => {
      const envelope = call[0] as TypedEventEnvelope<EventName>;
      const d = descriptors[i]!;
      expect(envelope.event_name).toBe(d.event_name);
      expect(envelope.aggregate_id).toBe(d.aggregate_id);
      expect(envelope.payload).toEqual(d.payload);
      expect(envelope.metadata).toEqual(d.metadata);
    });
  });

  it("P: zero facts -> no outbox interaction", async () => {
    const { outbox, enqueue } = fakeOutbox();
    await enqueueDineInEventFacts([], "corr-empty", outbox);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("Q: enqueue rejection propagates (NOT best-effort) so the tx can roll back", async () => {
    const { outbox, enqueue } = fakeOutbox();
    enqueue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("outbox write failed"));
    await expect(
      enqueueDineInEventFacts([billFact, requestFact], "corr-rb", outbox),
    ).rejects.toThrow("outbox write failed");
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("R: single SessionOpened enqueue rejection propagates to the caller", async () => {
    const { outbox, enqueue } = fakeOutbox();
    enqueue.mockRejectedValue(new Error("outbox write failed"));
    await expect(
      enqueueDineInEventFacts([openedFact], "corr-1", outbox),
    ).rejects.toThrow("outbox write failed");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
