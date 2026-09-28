import {
  boolean,
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
    // Durable reconciliation truth (PAYMENT_RECONCILIATION-A3). These are
    // explicit columns rather than metadata keys so reconciliation state
    // survives the additive webhook metadata updates that historically
    // replaced the whole jsonb blob.
    // Last status reported by the gateway itself, distinct from local status.
    gateway_status: text("gateway_status"),
    // NONE | CONVERGED | RETRY | MANUAL_REVIEW | ERROR (validated in app layer).
    reconciliation_status: text("reconciliation_status")
      .notNull()
      .default("NONE"),
    reconciliation_reason: text("reconciliation_reason"),
    manual_review: boolean("manual_review").notNull().default(false),
    last_reconciled_at: timestamp("last_reconciled_at", { withTimezone: true }),
    // Durable refund-initiation truth (PAYMENT_CANCEL_REFUND-A1). Explicit
    // columns rather than metadata keys so the exactly-once reservation
    // survives the additive webhook metadata merges that only own the
    // razorpay_* identity keys. `refund_requested_at` is the reservation gate:
    // once set it is NEVER cleared, so an ambiguous gateway timeout can never
    // reopen a refund for a second blind submission.
    refund_requested_at: timestamp("refund_requested_at", { withTimezone: true }),
    // Provider refund id returned by a successful gateway submission.
    refund_provider_id: text("refund_provider_id"),
    // NONE | RESERVED | SUBMITTED | MANUAL_REVIEW (validated in app layer).
    refund_initiation_status: text("refund_initiation_status")
      .notNull()
      .default("NONE"),
    refund_initiation_reason: text("refund_initiation_reason"),
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
    // Polymorphic target: a payment belongs to exactly one of an order or a gift.
    exactlyOneTarget: check(
      "payments_exactly_one_target",
      sql`(order_id IS NOT NULL AND gift_id IS NULL) OR (order_id IS NULL AND gift_id IS NOT NULL)`,
    ),
  }),
);
