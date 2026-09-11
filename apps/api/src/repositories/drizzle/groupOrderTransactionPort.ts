import type { DrizzleDb } from "../../lib/dbType";
import type { GroupOrderTransactionPort, GroupOrderTxRepos } from "../groupCartRepository";
import { DrizzleOrderRepository } from "./drizzleOrderRepository";
import { DrizzleGroupCartRepository } from "./drizzleGroupCartRepository";

// ============================================
// Drizzle group-order transaction port (frozen GROUP-CART-PG-DURABILITY-A1R1).
//
// Constructs EVERY tx-scoped repository over the SAME Drizzle transaction
// handle, so order + order_items + group_cart_contributors writes share one
// commit boundary. No nested transaction is opened by the tx-scoped repos.
// ============================================

export function buildGroupOrderTxRepos(tx: DrizzleDb): GroupOrderTxRepos {
  return {
    orders: new DrizzleOrderRepository(tx),
    carts: new DrizzleGroupCartRepository(tx),
  };
}

export class DrizzleGroupOrderTransactionPort
  implements GroupOrderTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(fn: (repos: GroupOrderTxRepos) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(buildGroupOrderTxRepos(tx)));
  }
}
