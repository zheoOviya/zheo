import {
  check,
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./ordering";
import { gifts } from "./gifts";

export const paymentStatusEnum = pgEnum("payment_status", [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "REFUNDED",
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
    provider_transaction_id: text("provider_transaction_id").notNull().unique(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("payments_order_idx").on(table.order_id),
    giftIdx: index("payments_gift_id_idx").on(table.gift_id),
    providerTxnIdx: index("payments_provider_txn_idx").on(
      table.provider_transaction_id,
    ),
    // Polymorphic target: a payment belongs to exactly one of an order or a gift.
    exactlyOneTarget: check(
      "payments_exactly_one_target",
      sql`(order_id IS NOT NULL AND gift_id IS NULL) OR (order_id IS NULL AND gift_id IS NOT NULL)`,
    ),
  }),
);
