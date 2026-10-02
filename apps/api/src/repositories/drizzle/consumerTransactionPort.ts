import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryConsumerTransactionPort,
  memoryEventConsumerDedup,
  type ConsumerTransactionPort,
  type ConsumerTxScope,
} from "../consumerTransactionContracts";
import {
  getStorageMode,
  sharedLoyaltyRepo,
  sharedNotificationRepo,
  sharedOrderRepo,
  sharedPromotionRepo,
} from "../shared";
import { DrizzleLoyaltyRepository } from "./drizzleLoyaltyRepository";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzlePromotionRepository } from "./drizzlePromotionRepository";
import { DrizzleNotificationRepository } from "../notificationRepository";
import { DrizzleEventOutboxRepository } from "./drizzleEventOutboxRepository";
import { memoryEventOutbox } from "../memoryEventOutbox";
import { tryMarkProcessedInTx } from "./drizzleEventConsumerDedupRepository";

// ============================================
// Drizzle consumer transaction port (EVT-C2).
//
// buildConsumerTxScope constructs EVERY tx-scoped repository from the SAME
// transaction handle, and the marker claim uses `tryMarkProcessedInTx` on that
// same handle. A consumer therefore inserts its dedup marker and applies its
// business effect inside one commit boundary: the marker cannot commit ahead of
// the effect, and an effect failure rolls the marker back so the event stays
// retryable.
//
// Drizzle nested `tx.transaction(...)` calls inside repository methods become
// savepoints of this same PostgreSQL transaction, so the whole scope still
// commits or rolls back as one unit.
// ============================================

export function buildConsumerTxScope(tx: DrizzleDb): ConsumerTxScope {
  return {
    claim: (consumerName, eventId) =>
      tryMarkProcessedInTx(tx, consumerName, eventId),
    loyalty: new DrizzleLoyaltyRepository(tx),
    orders: new DrizzleOrderRepository(tx),
    promotions: new DrizzlePromotionRepository(tx),
    notifications: new DrizzleNotificationRepository(tx),
    // EVT-B2B-NP3-A: the outbox enqueue runs on the SAME `tx`, so a nested
    // event row commits or rolls back with the marker and the business effect.
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleConsumerTransactionPort implements ConsumerTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (scope: ConsumerTxScope) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(buildConsumerTxScope(tx)));
  }
}

// ============================================
// Runtime composition (storage-mode aware).
//
//   postgres -> DrizzleConsumerTransactionPort (real single-transaction scope)
//   memory   -> MemoryConsumerTransactionPort (PASSTHROUGH; MEMORY_ATOMICITY_
//               GUARANTEE = NONE). Shares one process-wide dedup map so
//               duplicate deliveries are still suppressed in dev/test.
//
// getDb() is only reachable on the explicit postgres branch, so memory/test
// mode never constructs a Postgres client or falls back from a Postgres
// failure.
// ============================================

let _port: ConsumerTransactionPort | null = null;

export function getConsumerTransactionPort(): ConsumerTransactionPort {
  if (_port) return _port;
  if (getStorageMode() === "postgres") {
    _port = new DrizzleConsumerTransactionPort(getDb());
  } else {
    _port = new MemoryConsumerTransactionPort(
      () => ({
        loyalty: sharedLoyaltyRepo,
        orders: sharedOrderRepo,
        promotions: sharedPromotionRepo,
        notifications: sharedNotificationRepo,
        outbox: memoryEventOutbox,
      }),
      memoryEventConsumerDedup,
    );
  }
  return _port;
}

/** Test-only: drop the cached port and clear the process-wide memory markers. */
export function __resetConsumerTransactionPortForTests(): void {
  _port = null;
  memoryEventConsumerDedup._reset();
}
