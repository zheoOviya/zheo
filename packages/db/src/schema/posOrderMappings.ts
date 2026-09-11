import {
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { restaurants } from "./catalog";
import { orders } from "./ordering";

// ============================================
// POS order mapping persistence (Petpooja integration).
//
// Maps a third-party POS order identifier to the internally created order.
// Previously this mapping lived only in process memory, so a POS retry after
// restart created a duplicate order. This table makes the mapping durable and
// the DB the final arbiter of idempotency.
//
// Idempotency identity is restaurant-scoped: the same POS order id may appear
// under two different restaurants, so the uniqueness key is
// (restaurant_id, pos_order_id). There is intentionally NO unique(order_id):
// one internal order may in principle be referenced once, but the contract
// only freezes the composite POS identity. Historical mappings are NOT
// seeded/reconstructed (no fabricated backfill).
// ============================================

export const pos_order_mappings = pgTable(
  "pos_order_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pos_order_id: text("pos_order_id").notNull(),
    order_id: uuid("order_id").notNull(),
    restaurant_id: uuid("restaurant_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderFk: foreignKey({
      columns: [table.order_id],
      foreignColumns: [orders.id],
      name: "pos_order_mappings_order_id_fk",
    }),
    restaurantFk: foreignKey({
      columns: [table.restaurant_id],
      foreignColumns: [restaurants.id],
      name: "pos_order_mappings_restaurant_id_fk",
    }),
    restaurantPosUq: uniqueIndex("pos_order_mappings_restaurant_pos_uq").on(
      table.restaurant_id,
      table.pos_order_id,
    ),
  }),
);
