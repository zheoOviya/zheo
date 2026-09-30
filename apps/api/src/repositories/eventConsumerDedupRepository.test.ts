import { describe, expect, it, beforeEach } from "vitest";
import { MemoryEventConsumerDedupRepository } from "./eventConsumerDedupRepository";

// ============================================
// EVT-C1 memory semantics: C1-1 .. C1-4 + C1-8.
//
// Transactional atomicity (C1-6) is proven against real PostgreSQL in
// apps/api/integration/realPgEventConsumerDedup.ts; the memory store cannot
// prove it.
// ============================================

const CONSUMER_A = "retention.cashback";
const CONSUMER_B = "loyalty.order_stamp";
const EVENT_1 = "11111111-1111-4111-8111-111111111111";
const EVENT_2 = "22222222-2222-4222-8222-222222222222";

describe("MemoryEventConsumerDedupRepository (EVT-C1)", () => {
  let repo: MemoryEventConsumerDedupRepository;

  beforeEach(() => {
    repo = new MemoryEventConsumerDedupRepository();
  });

  it("C1-1 first (consumer,event_id) insert succeeds", async () => {
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(false);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);
  });

  it("C1-2 duplicate same pair does not create a second marker", async () => {
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    expect(repo._all()).toHaveLength(1);
  });

  it("C1-3 same event_id + different consumer is allowed", async () => {
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    await repo.markProcessed(CONSUMER_B, EVENT_1);
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);
    expect(await repo.hasProcessed(CONSUMER_B, EVENT_1)).toBe(true);
    expect(repo._all()).toHaveLength(2);
  });

  it("C1-4 same consumer + different event_id is allowed", async () => {
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    await repo.markProcessed(CONSUMER_A, EVENT_2);
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_2)).toBe(true);
    expect(repo._all()).toHaveLength(2);
  });

  it("C1-8 processed_at is recorded and durable across later calls", async () => {
    const fixed = new Date("2026-09-30T00:00:00.000Z");
    const clocked = new MemoryEventConsumerDedupRepository(() => fixed);
    await clocked.markProcessed(CONSUMER_A, EVENT_1);
    const first = clocked._all()[0]!;
    expect(first.processed_at).toBe("2026-09-30T00:00:00.000Z");

    // hasProcessed and a duplicate mark must not rewrite the marker timestamp.
    expect(await clocked.hasProcessed(CONSUMER_A, EVENT_1)).toBe(true);
    await clocked.markProcessed(CONSUMER_A, EVENT_1);
    expect(clocked._all()).toHaveLength(1);
    expect(clocked._all()[0]!.processed_at).toBe("2026-09-30T00:00:00.000Z");
  });

  it("_reset clears every marker", async () => {
    await repo.markProcessed(CONSUMER_A, EVENT_1);
    repo._reset();
    expect(await repo.hasProcessed(CONSUMER_A, EVENT_1)).toBe(false);
    expect(repo._all()).toHaveLength(0);
  });
});
