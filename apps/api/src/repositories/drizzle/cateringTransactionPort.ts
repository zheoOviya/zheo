import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryCateringTransactionPort,
  type CateringOrderRepo,
  type CateringTransactionPort,
  type CateringTxRepos,
} from "../cateringTransactionContracts";
import { getStorageMode } from "../shared";
import { memoryEventOutbox } from "../memoryEventOutbox";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzleEventOutboxRepository } from "./drizzleEventOutboxRepository";

// ============================================
// Drizzle catering transaction port (EVT-B2B-NP1).
//
// buildCateringTxRepos constructs the order repo AND the outbox from the SAME
// transaction handle, so create + DRAFT->CONFIRMED CAS + the CateringOrderCreated
// outbox INSERT commit or roll back as one unit.
// ============================================

export function buildCateringTxRepos(tx: DrizzleDb): CateringTxRepos {
  return {
    orders: new DrizzleOrderRepository(tx),
    outbox: new DrizzleEventOutboxRepository(tx),
  };
}

export class DrizzleCateringTransactionPort implements CateringTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: CateringTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildCateringTxRepos(tx)));
  }
}

// ============================================
// Runtime composition (storage-mode aware).
//
//   postgres -> DrizzleCateringTransactionPort (per-transaction repos built
//               from the tx handle; real atomicity)
//   memory   -> MemoryCateringTransactionPort (PASSTHROUGH over the service's
//               own order repo; no rollback/concurrency claim)
//
// getDb() is reachable only on the explicit postgres branch.
// ============================================

export function passthroughCateringTransactionPort(
  orders: CateringOrderRepo,
): CateringTransactionPort {
  return new MemoryCateringTransactionPort(() => ({
    orders,
    outbox: memoryEventOutbox,
  }));
}

export function selectCateringTransactionPort(
  orders: CateringOrderRepo,
): CateringTransactionPort {
  if (getStorageMode() === "postgres") {
    return new DrizzleCateringTransactionPort(getDb());
  }
  return passthroughCateringTransactionPort(orders);
}
