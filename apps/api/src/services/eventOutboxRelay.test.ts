import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventName, TypedEventEnvelope } from "@snakzap/types";
import { logger } from "../lib/logger";
import {
  MemoryEventOutboxRepository,
  type EventOutboxRow,
} from "../repositories/eventOutboxRepository";
import { EventOutboxRelay } from "./eventOutboxRelay";

// ============================================
// EVT-B1 relay semantics against the memory store.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY. These tests pin the relay's retry,
// lease-reclaim, dead-letter, stable-identity and transport-failure behaviour.
// Concurrent claim atomicity is Postgres-only and proven by the real-PG
// harness, not here.
// ============================================

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const LEASE = 30_000;
const PII = "+919999999999";

function envelope(
  eventId: string,
  aggregateId = "agg-1",
  eventName: EventName = "OrderPickedUp",
): TypedEventEnvelope<EventName> {
  return {
    event_id: eventId,
    event_name: eventName,
    aggregate_id: aggregateId,
    timestamp: new Date(T0),
    payload: { phone: PII, order_id: aggregateId },
    metadata: { correlation_id: "corr-1", phone: PII },
  } as unknown as TypedEventEnvelope<EventName>;
}

class RecordingPublisher {
  calls: TypedEventEnvelope<EventName>[] = [];
  failFor: (env: TypedEventEnvelope<EventName>) => boolean = () => false;

  async publish(env: TypedEventEnvelope<EventName>): Promise<void> {
    this.calls.push(env);
    if (this.failFor(env)) throw new Error("transport_down");
  }
}

class AckFailingRepo extends MemoryEventOutboxRepository {
  failAckOnce = false;
  async markPublished(id: string): Promise<void> {
    if (this.failAckOnce) {
      this.failAckOnce = false;
      throw new Error("crash_after_publish_before_delete");
    }
    return super.markPublished(id);
  }
}

describe("EventOutboxRelay (EVT-B1)", () => {
  let clockMs: number;
  let repo: MemoryEventOutboxRepository;
  let publisher: RecordingPublisher;
  let relay: EventOutboxRelay;

  function build(deps: {
    repo?: MemoryEventOutboxRepository;
    maxAttempts?: number;
  } = {}): void {
    relay = new EventOutboxRelay({
      repo: deps.repo ?? repo,
      publish: (env) => publisher.publish(env),
      now: () => new Date(clockMs),
      leaseMs: LEASE,
      maxAttempts: deps.maxAttempts ?? 5,
      batchSize: 50,
    });
  }

  beforeEach(() => {
    clockMs = T0;
    repo = new MemoryEventOutboxRepository(() => new Date(clockMs));
    publisher = new RecordingPublisher();
    build();
  });

  it("EV3 publishes a due row and deletes it on success", async () => {
    await repo.enqueue(envelope("evt-1"));

    const result = await relay.tick();

    expect(result).toMatchObject({ claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]!.event_id).toBe("evt-1");
    expect(await repo.outstandingCount()).toBe(0);
  });

  it("B1-PUB-1 a transport failure is visible: the row is NOT deleted and is rescheduled", async () => {
    await repo.enqueue(envelope("evt-1"));
    publisher.failFor = () => true;

    const result = await relay.tick();

    expect(result).toMatchObject({ claimed: 1, published: 0, retried: 1 });
    const [row] = repo._all();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(Date.parse(row!.next_attempt_at)).toBeGreaterThan(clockMs);
  });

  it("EV11 a failed publish retries after backoff then succeeds", async () => {
    await repo.enqueue(envelope("evt-1"));
    publisher.failFor = () => true;
    await relay.tick();

    const [afterFail] = repo._all();
    clockMs = Date.parse(afterFail!.next_attempt_at) + 1;
    publisher.failFor = () => false;
    const result = await relay.tick();

    expect(result).toMatchObject({ published: 1 });
    expect(await repo.outstandingCount()).toBe(0);
  });

  it("EV12 dead-letters after max attempts and stops retrying", async () => {
    build({ maxAttempts: 3 });
    await repo.enqueue(envelope("evt-1"));
    publisher.failFor = () => true;

    for (let i = 0; i < 3; i += 1) {
      await relay.tick();
      const rows = repo._all();
      if (rows[0]) clockMs = Date.parse(rows[0].next_attempt_at) + 1;
    }

    const [dead] = repo._all();
    expect(dead!.status).toBe("DEAD");
    expect(dead!.attempts).toBe(3);

    clockMs += 10_000_000;
    const result = await relay.tick();
    expect(result.claimed).toBe(0);
  });

  it("B1-ID-1 every retry republishes the SAME persisted event_id", async () => {
    build({ maxAttempts: 5 });
    await repo.enqueue(envelope("evt-stable"));
    let deliveries = 0;
    publisher.failFor = () => {
      deliveries += 1;
      return deliveries < 3;
    };

    for (let i = 0; i < 3; i += 1) {
      await relay.tick();
      const rows = repo._all();
      if (rows[0] && rows[0].status !== "PENDING") break;
      if (rows[0]) clockMs = Date.parse(rows[0].next_attempt_at) + 1;
    }

    expect(publisher.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of publisher.calls) {
      expect(call.event_id).toBe("evt-stable");
    }
  });

  it("EV5 a worker that claims and dies before publish is reclaimed after the lease", async () => {
    await repo.enqueue(envelope("evt-1"));
    // Simulate a crashed worker: claim but never publish/ack.
    await repo.claimDue({ limit: 10, now: new Date(clockMs), leaseMs: LEASE });
    expect(repo._all()[0]!.status).toBe("CLAIMED");

    clockMs = T0 + LEASE + 1;
    const result = await relay.tick();

    expect(result).toMatchObject({ claimed: 1, published: 1 });
    expect(publisher.calls[0]!.event_id).toBe("evt-1");
    expect(await repo.outstandingCount()).toBe(0);
  });

  it("B1-DUP-1 a crash after publish but before delete may replay the same event_id", async () => {
    const ackRepo = new AckFailingRepo(() => new Date(clockMs));
    repo = ackRepo;
    build({ repo: ackRepo });
    await repo.enqueue(envelope("evt-dup"));

    ackRepo.failAckOnce = true;
    await relay.tick(); // publish succeeds, delete fails -> rescheduled

    const [rescheduled] = repo._all();
    clockMs = Date.parse(rescheduled!.next_attempt_at) + 1;
    await relay.tick(); // republished

    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[0]!.event_id).toBe("evt-dup");
    expect(publisher.calls[1]!.event_id).toBe("evt-dup");
  });

  it("EV14 aggregate isolation: one failing aggregate does not block another", async () => {
    await repo.enqueue(envelope("evt-a", "agg-a"));
    await repo.enqueue(envelope("evt-b", "agg-b"));
    publisher.failFor = (env) => env.aggregate_id === "agg-a";

    const result = await relay.tick();

    expect(result).toMatchObject({ claimed: 2, published: 1, retried: 1 });
    const remaining = repo._all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.event_id).toBe("evt-a");
  });

  it("EV15 relay logs never contain payload or PII", async () => {
    await repo.enqueue(envelope("evt-1"));
    publisher.failFor = () => true;

    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      await relay.tick();
    } finally {
      const serialized = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
        .map((args) => JSON.stringify(args))
        .join("\n");
      expect(serialized).not.toContain(PII);
      expect(serialized).not.toContain("payload");
      expect(serialized).toContain("event_outbox");
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
