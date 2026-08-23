import {
  check,
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./ordering";
import { gifts } from "./gifts";

// Enum literal order MUST match the live Postgres value order. The
// concurrency migration appended INITIATING/FAILED_INITIATION via
// `ALTER TYPE ... ADD VALUE`, so they sit after the original five values.
export const paymentStatusEnum = pgEnum("payment_status", [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "REFUNDED",
  "INITIATING",
  "FAILED_INITIATION",
]);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    order_id: uuid("order_id").references(() => orders.id),
    // Gift payments carry a gift_id instead of an order_id. The
    // exactly-one-of invariant is enforced by the DB-level CHECK below.
    gift_id: uuid("gift_id").references(() => gifts.id),
    provider: text("provider").notNull().default("razorpay"),
    // Populated once the provider order is created; NULL while the payment
    // intent is still being prepared (INITIATING/FAILED_INITIATION).
    provider_transaction_id: text("provider_transaction_id").unique(),
    // Gateway receipt: derived from the payment intent id so retries and
    // lease takeovers always reuse the same receipt (never mint a duplicate
    // provider order).
    receipt: text("receipt"),
    // Initiation lease. A create call registers itself as the lease holder;
    // after the lease expires another process may take the intent over. This
    // bounds how many processes may touch the provider concurrently.
    lease_owner: text("lease_owner"),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("payments_order_idx").on(table.order_id),
    giftIdx: index("payments_gift_id_idx").on(table.gift_id),
    providerTxnIdx: index("payments_provider_txn_idx").on(
      table.provider_transaction_id,
    ),
    // One canonical payment intent per order / per gift: exactly one row may
    // reference a given order_id and one row may reference a given gift_id.
    // NULLs are excluded so multiple rows may carry no target (none should
    // ever exist due to the CHECK below) and multiple INITIATING rows never
    // share a target.
    orderUnique: uniqueIndex("payments_order_unique")
      .on(table.order_id)
      .where(sql`${table.order_id} IS NOT NULL`),
    giftUnique: uniqueIndex("payments_gift_unique")
      .on(table.gift_id)
      .where(sql`${table.gift_id} IS NOT NULL`),
    // Polymorphic target: a payment belongs to exactly one of an order or a gift.
    exactlyOneTarget: check(
      "payments_exactly_one_target",
      sql`(order_id IS NOT NULL AND gift_id IS NULL) OR (order_id IS NULL AND gift_id IS NOT NULL)`,
    ),
  }),
);
