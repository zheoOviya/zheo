import { beforeEach, describe, expect, it } from "vitest";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import {
  MemoryEventOutboxRepository,
  outboxRowToEnvelope,
} from "./eventOutboxRepository";

// ============================================
// EVT-B1 memory outbox repository.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY. These tests pin the lease/retry/ack
// CONTRACT. They do NOT prove Postgres durability or concurrent claim safety —
// that is proven by the real-Postgres harness.
// ============================================

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const LEASE = 30_000;

function envelope(
  eventId: string,
  eventName: EventName = "OrderPickedUp",
  aggregateId = "agg-1",
): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: eventName,
    aggregate_id: aggregateId,
    timestamp: new Date(T0),
    payload: { order_id: aggregateId },
    metadata: { correlation_id: "corr-1" },
  } as unknown as TypedEventEnvelope<EventName>;
}

describe("MemoryEventOutboxRepository (EVT-B1, NON_DURABLE_TEST_PARITY)", () => {
  let clockMs: number;
  let repo: MemoryEventOutboxRepository;

  beforeEach(() => {
    clockMs = T0;
    repo = new MemoryEventOutboxRepository(() => new Date(clockMs));
  });

  it("EV16 enqueue persists a PENDING row with attempts=0 at the injected clock", async () => {
    await repo.enqueue(envelope("evt-1"));

    const [row] = repo._all();
    expect(row).toMatchObject({
      event_id: "evt-1",
      event_name: "OrderPickedUp",
      status: "PENDING",
      attempts: 0,
    });
    expect(Date.parse(row!.next_attempt_at)).toBe(T0);
    expect(Date.parse(row!.created_at)).toBe(T0);
  });

  it("claimDue returns due PENDING rows and moves them to CLAIMED with a lease", async () => {
    await repo.enqueue(envelope("evt-1"));

    const claimed = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.event_id).toBe("evt-1");
    expect(claimed[0]!.status).toBe("CLAIMED");
    expect(Date.parse(claimed[0]!.next_attempt_at)).toBe(T0 + LEASE);
    expect(repo._all()[0]!.status).toBe("CLAIMED");
  });

  it("claimDue skips rows whose next_attempt_at is in the future", async () => {
    await repo.enqueue(envelope("evt-1"));
    await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    const claimed = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });
    expect(claimed).toHaveLength(0);
  });

  it("B1-LEASE-1 reclaims an expired CLAIMED row after the lease elapses", async () => {
    await repo.enqueue(envelope("evt-1"));
    await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    clockMs = T0 + LEASE + 1;
    const reclaimed = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.event_id).toBe("evt-1");
    expect(reclaimed[0]!.status).toBe("CLAIMED");
  });

  it("EV12 DEAD rows are never claimed again", async () => {
    await repo.enqueue(envelope("evt-1"));
    const [row] = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });
    await repo.markFailed({
      id: row!.id,
      attempts: 5,
      status: "DEAD",
      nextAttemptAt: null,
    });

    clockMs = T0 + 10_000_000;
    const claimed = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });
    expect(claimed).toHaveLength(0);
    expect(repo._all()[0]!.status).toBe("DEAD");
  });

  it("B1-ACK-1 markPublished deletes the row", async () => {
    await repo.enqueue(envelope("evt-1"));
    const [row] = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    await repo.markPublished(row!.id);
    expect(repo._all()).toHaveLength(0);
  });

  it("EV11 markFailed records attempts/status and the next backoff time", async () => {
    await repo.enqueue(envelope("evt-1"));
    const [row] = await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });

    const next = new Date(T0 + 60_000);
    await repo.markFailed({
      id: row!.id,
      attempts: 1,
      status: "PENDING",
      nextAttemptAt: next,
    });

    const stored = repo._all()[0]!;
    expect(stored.attempts).toBe(1);
    expect(stored.status).toBe("PENDING");
    expect(Date.parse(stored.next_attempt_at)).toBe(next.getTime());
  });

  it("B1-ID-1 reconstruction preserves the persisted event_id", async () => {
    await repo.enqueue(envelope("evt-stable"));
    const [row] = repo._all();
    const rebuilt = outboxRowToEnvelope(row!);
    expect(rebuilt.event_id).toBe("evt-stable");
    expect(rebuilt.aggregate_id).toBe("agg-1");
  });

  it("EV14 outstandingCount excludes DEAD and isolates aggregates", async () => {
    await repo.enqueue(envelope("evt-a", "OrderPickedUp", "agg-a"));
    await repo.enqueue(envelope("evt-b", "OrderPickedUp", "agg-b"));
    expect(await repo.outstandingCount()).toBe(2);

    const [first] = await repo.claimDue({ limit: 1, now: new Date(clockMs), leaseMs: LEASE });
    await repo.markPublished(first!.id);

    expect(await repo.outstandingCount()).toBe(1);
    expect(repo._all()[0]!.event_id).toBe("evt-b");
  });
});
