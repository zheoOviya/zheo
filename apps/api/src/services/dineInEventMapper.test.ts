import { describe, expect, it } from "vitest";
import {
  BillRequestedEventSchema,
  ServiceRequestCreatedEventSchema,
  SessionOpenedEventSchema,
} from "@snakzap/types";
import {
  mapDineInEventFact,
  mapDineInEventFacts,
  type DineInEnvelopeDescriptor,
} from "./dineInEventMapper";
import type { DineInEventFact } from "./dineInSession";

// ------------------------------------------------------------
// D2.5C9.1 pure mapper tests. No DB, no EventBus, no Redis.
// Payload schemas require uuid ids, so fixtures use valid UUIDs.
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

const serviceRequestFact: DineInEventFact = {
  kind: "SERVICE_REQUEST_CREATED",
  request_id: REQUEST_ID,
  session_id: SESSION_ID,
  restaurant_id: RESTAURANT_ID,
  request_type: "BRING_BILL",
  request_status: "PENDING",
};

const CORR = "corr-abc-123";

describe("mapDineInEventFact pure mapping (D2.5C9.1)", () => {
  it("A: SessionOpened exact event name/payload/aggregate_id", () => {
    const d = mapDineInEventFact(openedFact, CORR);
    expect(d.event_name).toBe("SessionOpened");
    // aggregate = DiningSession.id, NOT restaurant/table.
    expect(d.aggregate_id).toBe(SESSION_ID);
    expect(d.payload).toEqual({
      restaurant_id: RESTAURANT_ID,
      table_id: TABLE_ID,
      customer_user_id: CUSTOMER_ID,
    });
    // Payload conforms to the frozen zod contract.
    expect(SessionOpenedEventSchema.parse(d.payload)).toEqual(d.payload);
  });

  it("B: BillRequested exact event name/payload/aggregate_id", () => {
    const d = mapDineInEventFact(billFact, CORR);
    expect(d.event_name).toBe("BillRequested");
    // aggregate = DiningSession.id (NOT the bill, NOT the table).
    expect(d.aggregate_id).toBe(SESSION_ID);
    expect(d.payload).toEqual({
      restaurant_id: RESTAURANT_ID,
      table_id: TABLE_ID,
      session_bill_id: BILL_ID,
      total_amount: 105,
    });
    expect(BillRequestedEventSchema.parse(d.payload)).toEqual(d.payload);
  });

  it("C: ServiceRequestCreated exact name/payload/aggregate_id", () => {
    const d = mapDineInEventFact(serviceRequestFact, CORR);
    expect(d.event_name).toBe("ServiceRequestCreated");
    // aggregate = ServiceRequest.id.
    expect(d.aggregate_id).toBe(REQUEST_ID);
    expect(d.payload).toEqual({
      restaurant_id: RESTAURANT_ID,
      session_id: SESSION_ID,
      request_type: "BRING_BILL",
      request_status: "PENDING",
    });
    expect(ServiceRequestCreatedEventSchema.parse(d.payload)).toEqual(d.payload);
  });

  it("D: requestBill's two facts map with the same supplied correlation_id", () => {
    const pair = [billFact, serviceRequestFact];
    const descriptors = mapDineInEventFacts(pair, "corr-shared");
    expect(descriptors.map((d) => d.event_name)).toEqual([
      "BillRequested",
      "ServiceRequestCreated",
    ]);
    // Both envelopes receive the SAME originating correlation id.
    expect(descriptors[0]!.metadata.correlation_id).toBe("corr-shared");
    expect(descriptors[1]!.metadata.correlation_id).toBe("corr-shared");
  });

  it("E: mapping never invents a new correlation_id", () => {
    const d = mapDineInEventFact(openedFact, CORR);
    expect(d.metadata.correlation_id).toBe(CORR);
    // Non-uuid passthrough proves no randomUUID/derivation is happening.
    expect(d.metadata.correlation_id).toBe("corr-abc-123");
    const other = mapDineInEventFact(openedFact, "corr-other");
    expect(other.metadata.correlation_id).toBe("corr-other");
  });

  it("F: forbidden fields absent (table_token/payment/PII/full DTO)", () => {
    for (const fact of [openedFact, billFact, serviceRequestFact]) {
      const d = mapDineInEventFact(fact, CORR) as DineInEnvelopeDescriptor;
      const serialized = JSON.stringify(d.payload);
      expect(serialized).not.toContain("table_token");
      expect(serialized).not.toContain("payment");
      expect(serialized).not.toContain("phone");
      expect(serialized).not.toContain("email");
      expect(serialized).not.toContain("created_at");
      expect(serialized).not.toContain("updated_at");
      expect(serialized).not.toContain("owner_user_id");
      // Exact key sets prove only the frozen payload fields survive.
      const keys = Object.keys(d.payload).sort();
      if (d.event_name === "SessionOpened") {
        expect(keys).toEqual(
          ["customer_user_id", "restaurant_id", "table_id"].sort(),
        );
      } else if (d.event_name === "BillRequested") {
        expect(keys).toEqual(
          ["restaurant_id", "session_bill_id", "table_id", "total_amount"].sort(),
        );
      } else {
        expect(keys).toEqual(
          ["request_status", "request_type", "restaurant_id", "session_id"].sort(),
        );
      }
    }
  });

  it("G: BillRequested total_amount comes from the persisted semantic fact (no recompute)", () => {
    const persisted: DineInEventFact = {
      kind: "BILL_REQUESTED",
      session_id: SESSION_ID,
      bill_id: BILL_ID,
      restaurant_id: RESTAURANT_ID,
      table_id: TABLE_ID,
      total_amount: 105.5,
    };
    const d = mapDineInEventFact(persisted, CORR);
    if (d.event_name !== "BillRequested") {
      throw new Error("expected BillRequested descriptor");
    }
    expect(d.payload.total_amount).toBe(105.5);
    expect(typeof d.payload.total_amount).toBe("number");
    expect(d.payload.total_amount).toBeGreaterThanOrEqual(0);
  });

  it("H: mapper performs no DB/EventBus calls (pure, deterministic, input frozen)", () => {
    // Deterministic: same input + correlation -> identical descriptors.
    const a = mapDineInEventFact(billFact, CORR);
    const b = mapDineInEventFact(billFact, CORR);
    expect(a).toEqual(b);

    // Input is treated as read-only: a frozen fact must not throw/mutate.
    const frozen = Object.freeze({ ...billFact }) as DineInEventFact;
    const c = mapDineInEventFact(frozen, CORR);
    expect(c.payload).toEqual({
      restaurant_id: RESTAURANT_ID,
      table_id: TABLE_ID,
      session_bill_id: BILL_ID,
      total_amount: 105,
    });

    // Descriptor is a plain creation input: no event_id, no timestamp,
    // no envelope fields — envelope construction is deferred.
    for (const d of [a, b, c]) {
      expect(d).not.toHaveProperty("event_id");
      expect(d).not.toHaveProperty("timestamp");
    }
  });

  it("I: repeat outcome eventFacts=[] maps to zero descriptors", () => {
    expect(mapDineInEventFacts([], CORR)).toEqual([]);
    expect(mapDineInEventFacts([], CORR)).toHaveLength(0);
  });
});
