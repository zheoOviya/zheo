import type { DrizzleDb } from "../../lib/dbType";
import type { PosImportTransactionPort, PosImportTxRepos } from "../posRepository";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzlePosOrderRepository } from "./drizzlePosOrderRepository";

// ============================================
// Drizzle POS-import transaction port (POS-MAPPING-PG-DURABILITY frozen).
//
// Constructs EVERY tx-scoped repository over the SAME Drizzle transaction
// handle, so the internal order write and the pos_order_mappings idempotency
// row share one commit boundary. No nested transaction is opened by the
// tx-scoped repos.
// ============================================

export function buildPosImportTxRepos(tx: DrizzleDb): PosImportTxRepos {
  return {
    orders: new DrizzleOrderRepository(tx),
    pos: new DrizzlePosOrderRepository(tx),
  };
}

export class DrizzlePosImportTransactionPort implements PosImportTransactionPort {
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: PosImportTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(buildPosImportTxRepos(tx)));
  }
}
