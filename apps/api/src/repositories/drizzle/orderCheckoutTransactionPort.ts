import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryOrderCheckoutTransactionPort,
  type OrderCheckoutGiftRepo,
  type OrderCheckoutOrderRepo,
  type OrderCheckoutTransactionPort,
  type OrderCheckoutTxRepos,
} from "../orderCheckoutContracts";
import { getStorageMode } from "../shared";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzleGiftRepository } from "./drizzleGiftRepository";

// ============================================
// Drizzle consumer-checkout transaction port (ORDER-AGGREGATE-IDEMPOTENCY-A3).
//
// buildOrderCheckoutTxRepos constructs EVERY tx-scoped repository from the SAME
// transaction handle so the order row, all of its items, and every gift bind
// commit or roll back together. No global/shared repository instance is used.
// ============================================

export function buildOrderCheckoutTxRepos(tx: DrizzleDb): OrderCheckoutTxRepos {
  return {
    orders: new DrizzleOrderRepository(tx),
    gifts: new DrizzleGiftRepository(tx),
  };
}

export class DrizzleOrderCheckoutTransactionPort
  implements OrderCheckoutTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: OrderCheckoutTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildOrderCheckoutTxRepos(tx)));
  }
}

// ============================================
// Runtime composition (storage-mode aware).
//
//   postgres -> DrizzleOrderCheckoutTransactionPort (per-transaction repos
//               built from the tx handle; real atomicity)
//   memory   -> MemoryOrderCheckoutTransactionPort (PASSTHROUGH over the repos
//               the service was constructed with; no rollback/concurrency claim)
//
// getDb() is only reachable on the explicit postgres branch, so memory/test
// mode never constructs a Postgres client or falls back from a Postgres
// failure. The memory bundle is resolved from the service's own repositories at
// call time, so the transaction observes the same logical stores as the routes
// and no stale instances survive a test reset.
// ============================================

/**
 * Placeholder used only when a caller constructed the service without a gift
 * repository. Checkout rejects any gift line before this can be reached, so it
 * exists purely to keep the tx repo bundle total.
 */
const UNCONFIGURED_GIFT_REPO: OrderCheckoutGiftRepo = {
  bindToOrder: async () => {
    throw new Error("gift_repository_not_configured");
  },
  releaseFromOrder: async () => {
    throw new Error("gift_repository_not_configured");
  },
};

/**
 * Builds an explicit passthrough port over the supplied repositories. Used by
 * the memory branch and by callers that already own an outer transaction (the
 * POS importer), so checkout never opens a nested/unrelated transaction.
 */
export function passthroughOrderCheckoutTransactionPort(
  orders: OrderCheckoutOrderRepo,
  gifts?: OrderCheckoutGiftRepo,
): OrderCheckoutTransactionPort {
  return new MemoryOrderCheckoutTransactionPort(() => ({
    orders,
    gifts: gifts ?? UNCONFIGURED_GIFT_REPO,
  }));
}

export function selectOrderCheckoutTransactionPort(
  orders: OrderCheckoutOrderRepo,
  gifts?: OrderCheckoutGiftRepo,
): OrderCheckoutTransactionPort {
  if (getStorageMode() === "postgres") {
    return new DrizzleOrderCheckoutTransactionPort(getDb());
  }
  return passthroughOrderCheckoutTransactionPort(orders, gifts);
}
