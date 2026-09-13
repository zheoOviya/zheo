import {
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orders } from "./ordering";
import { users } from "./identity";

// ============================================
// Durable consumer checkout idempotency
// (ORDER-IDEMPOTENCY-DURABILITY-A2).
//
// One row per (user_id, idempotency_key). The composite unique index is the
// concurrency authority: the claim INSERT and the order/order_items writes
// share one transaction, so a rolled-back checkout leaves NO claim behind and
// a committed checkout always references its order. `order_id` is nullable
// only for the brief claim->attach window inside that transaction; a committed
// successful record always has it set.
//
// Uniqueness is user-scoped on purpose: client-supplied keys may collide
// across users, so a global UNIQUE(idempotency_key) is intentionally avoided.
// No backfill / no UPDATE migration: historical orders have no claim.
// ============================================

export const checkout_idempotency = pgTable(
  "checkout_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    request_fingerprint: text("request_fingerprint").notNull(),
    order_id: uuid("order_id"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userFk: foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "checkout_idempotency_user_id_fk",
    }),
    orderFk: foreignKey({
      columns: [table.order_id],
      foreignColumns: [orders.id],
      name: "checkout_idempotency_order_id_fk",
    }),
    userKeyUq: uniqueIndex("checkout_idempotency_user_key_uq").on(
      table.user_id,
      table.idempotency_key,
    ),
  }),
);
