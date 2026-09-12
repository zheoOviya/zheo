import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryFulfillmentTransactionPort,
  type FulfillmentTransactionPort,
  type FulfillmentTxRepos,
} from "../fulfillmentAtomicityContracts";
import { getStorageMode, sharedGiftRepo, sharedOrderRepo } from "../shared";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzleGiftRepository } from "./drizzleGiftRepository";

// ============================================
// Drizzle fulfillment transaction port (FULFILLMENT-CAS-OTP-ATOMICITY).
//
// buildFulfillmentTxRepos constructs EVERY tx-scoped repository from the SAME
// transaction handle so an order CAS and any gift release/fulfillment share one
// commit boundary. No global/shared repository instance is used.
// ============================================

export function buildFulfillmentTxRepos(tx: DrizzleDb): FulfillmentTxRepos {
  return {
    orders: new DrizzleOrderRepository(tx),
    gifts: new DrizzleGiftRepository(tx),
  };
}

export class DrizzleFulfillmentTransactionPort
  implements FulfillmentTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: FulfillmentTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildFulfillmentTxRepos(tx)));
  }
}

/** Factory for the Postgres-backed fulfillment transaction port. */
export function createFulfillmentTransactionPort(
  db: DrizzleDb,
): FulfillmentTransactionPort {
  return new DrizzleFulfillmentTransactionPort(db);
}

// ============================================
// Runtime composition (storage-mode aware).
//
//   postgres -> DrizzleFulfillmentTransactionPort (per-transaction repos built
//               from the tx handle; real atomicity)
//   memory   -> MemoryFulfillmentTransactionPort (PASSTHROUGH over the
//               route-visible memory repos; no rollback/concurrency claim)
//
// getDb() is only reachable on the explicit postgres branch, so memory/test
// mode never constructs a Postgres client or falls back from a Postgres
// failure. The memory bundle is resolved from existing getters at call time,
// so the transaction observes the same logical stores as the routes and no
// stale instances survive a test reset.
// ============================================

function memoryFulfillmentTxRepos(): FulfillmentTxRepos {
  return {
    orders: sharedOrderRepo,
    gifts: sharedGiftRepo,
  };
}

let _port: FulfillmentTransactionPort | null = null;

export function getFulfillmentTransactionPort(): FulfillmentTransactionPort {
  if (_port) return _port;
  if (getStorageMode() === "postgres") {
    _port = new DrizzleFulfillmentTransactionPort(getDb());
  } else {
    _port = new MemoryFulfillmentTransactionPort(memoryFulfillmentTxRepos);
  }
  return _port;
}
