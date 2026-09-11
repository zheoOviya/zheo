import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { restaurants } from "./catalog";
import { users } from "./identity";
import { orders } from "./ordering";

// ============================================
// Group cart persistence (ordering bounded context, O02).
//
// The shareable group cart is a durable session that points at ONE existing
// DRAFT order. Item/pricing truth stays in `orders` + `order_items`; this
// schema only owns the session (token) and the per-contributor attribution
// the order tables cannot express (order_items has no user column).
//
// Contributor attribution items are a display projection of the items already
// written to `order_items`; they are written in the same transaction as the
// order items, so the two can never diverge. No raw phone / email / identity
// payload is stored - only the masked display_name / avatar_seed projection.
// ============================================

export interface GroupCartContributionItem {
  menu_item_id: string;
  name: string;
  quantity: number;
  price: number;
}

export const groupCarts = pgTable(
  "group_carts",
  {
    /** Share key, e.g. "gc_<24 hex>". Primary key so the DB is the final
     *  arbiter for token uniqueness (collision -> 23505 -> bounded retry). */
    token: text("token").primaryKey(),
    /** Exactly one DRAFT order per group cart. */
    order_id: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    created_by: uuid("created_by")
      .notNull()
      .references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderUq: uniqueIndex("group_carts_order_uq").on(table.order_id),
    createdByIdx: index("group_carts_created_by_idx").on(table.created_by),
  }),
);

export const groupCartContributors = pgTable(
  "group_cart_contributors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    group_cart_id: text("group_cart_id")
      .notNull()
      .references(() => groupCarts.token, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id),
    display_name: text("display_name").notNull(),
    avatar_seed: text("avatar_seed").notNull(),
    items: jsonb("items")
      .$type<GroupCartContributionItem[]>()
      .notNull()
      .default([]),
    added_at: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    memberUq: uniqueIndex("group_cart_contributors_member_uq").on(
      table.group_cart_id,
      table.user_id,
    ),
  }),
);
