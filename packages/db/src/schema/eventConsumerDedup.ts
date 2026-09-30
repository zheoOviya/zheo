import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// ============================================
// Durable event-consumer dedup inbox (EVT-C1).
//
// Generic at-most-once marker for event consumers. One row per
// (consumer_name, event_id); the composite PRIMARY KEY is the concurrency
// authority. A consumer records the marker on the SAME transaction handle as
// its business effect (EVT-C2), so the effect and the marker commit or roll
// back together.
//
// Deliberately generic and PII-free: no order_id / gift_id / notification
// columns and no foreign keys. The event_id is the durable event identity from
// the event envelope, NOT a business key.
// ============================================

export const event_consumer_dedup = pgTable(
  "event_consumer_dedup",
  {
    consumer_name: text("consumer_name").notNull(),
    event_id: uuid("event_id").notNull(),
    processed_at: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.consumer_name, table.event_id] }),
  }),
);
