import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypedEventEnvelope } from "@snakzap/types";
import * as eventBus from "../lib/eventBus";
import { logger } from "../lib/logger";
import { mapDineInEventFacts } from "./dineInEventMapper";
import { emitDineInEventFactsBestEffort } from "./dineInEventEmitter";
import type { DineInEventFact } from "./dineInSession";

// ------------------------------------------------------------
// D2.5C9.2 helper-level tests. The real best-effort emitter runs against a
// spied eventBus.emit — no Redis, no DB, no handlers.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitDineInEventFactsBestEffort (D2.5C9.2)", () => {
  it("D: requestBill pair shares the supplied correlation_id", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    await emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb");
    expect(emitSpy).toHaveBeenCalledTimes(2);
    const env0 = emitSpy.mock.calls[0]![0]!;
    const env1 = emitSpy.mock.calls[1]![0]!;
    expect(env0.metadata).toMatchObject({ correlation_id: "corr-rb" });
    expect(env1.metadata).toMatchObject({ correlation_id: "corr-rb" });
  });

  it("E: two requestBill envelopes have distinct event_id values", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    await emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb");
    const env0 = emitSpy.mock.calls[0]![0]!;
    const env1 = emitSpy.mock.calls[1]![0]!;
    expect(env0.event_id).toBeDefined();
    expect(env1.event_id).toBeDefined();
    expect(env0.event_id).not.toBe(env1.event_id);
  });

  it("F: envelope timestamp is post-commit observation time, not a domain timestamp", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    const before = Date.now();
    await emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb");
    const after = Date.now();
    const env0 = emitSpy.mock.calls[0]![0]!;
    expect(env0.timestamp).toBeInstanceOf(Date);
    // Timestamp is created at emission time (post-commit), NOT a frozen
    // domain timestamp like bill_requested_at / created_at.
    const ts = env0.timestamp.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
    // Payload carries NO domain transition timestamps.
    const serialized = JSON.stringify(env0.payload);
    expect(serialized).not.toContain("created_at");
    expect(serialized).not.toContain("bill_requested_at");
    expect(serialized).not.toContain("requested_at");
  });

  it("N: emitted names/payloads/aggregate ids match the C9.1 descriptors exactly", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockResolvedValue(undefined);
    const facts = [billFact, requestFact];
    await emitDineInEventFactsBestEffort(facts, "corr-rb");
    const descriptors = mapDineInEventFacts(facts, "corr-rb");
    expect(emitSpy).toHaveBeenCalledTimes(descriptors.length);
    emitSpy.mock.calls.forEach(
      ([envelope]: [TypedEventEnvelope, ...unknown[]], i: number) => {
        const d = descriptors[i]!;
        expect(envelope.event_name).toBe(d.event_name);
        expect(envelope.aggregate_id).toBe(d.aggregate_id);
        expect(envelope.payload).toEqual(d.payload);
        expect(envelope.metadata).toEqual(d.metadata);
      },
    );
  });

  it("I: first emit failure -> second event is still attempted", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockImplementation(async () => {
      throw new Error("redis down");
    });
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    emitSpy.mockRejectedValueOnce(new Error("first fails")).mockResolvedValueOnce(undefined);

    await expect(
      emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb"),
    ).resolves.toBeUndefined();
    // BOTH events attempted independently.
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });

  it("J: second emit failure -> helper still succeeds, first emit already done", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockImplementation(async () => {
      throw new Error("boom");
    });
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    emitSpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second fails"));

    await expect(
      emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb"),
    ).resolves.toBeUndefined();
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });

  it("K: single SessionOpened emit failure -> helper still succeeds", async () => {
    const emitSpy = vi.spyOn(eventBus, "emit").mockRejectedValue(new Error("redis down"));
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    await expect(
      emitDineInEventFactsBestEffort([openedFact], "corr-1"),
    ).resolves.toBeUndefined();
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("O: failure log carries identity fields but no sensitive payload", async () => {
    vi.spyOn(eventBus, "emit").mockRejectedValue(new Error("redis down"));
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);

    await emitDineInEventFactsBestEffort([billFact, requestFact], "corr-rb");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const firstLog = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstLog.message).toBe("dinein_event_emit_failed");
    expect(firstLog.event_name).toBe("BillRequested");
    expect(firstLog.aggregate_id).toBe(SESSION_ID);
    expect(firstLog.correlation_id).toBe("corr-rb");
    expect(firstLog.error).toBe("redis down");
    const serialized = JSON.stringify(firstLog);
    expect(serialized).not.toContain("table_token");
    expect(serialized).not.toContain("payment");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("total_amount");
  });
});
