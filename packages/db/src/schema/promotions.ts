import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================
// Promotion persistence (V09 Promotions Builder catalog).
//
// Promotions were previously held only in process memory, so the catalog
// vanished on restart and was invisible across instances. This table makes
// it durable. The catalog is intentionally GLOBAL/UNSCOPED: no
// restaurant_id/vendor_id is added, matching the current route contract
// (accepted pre-existing product limitation). Historical promotions are NOT
// seeded here, and nothing is reconstructed from orders/audit/events (no
// fabricated backfill).
// ============================================

export const promotions = pgTable("promotions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  discount_type: text("discount_type").notNull(),
  value: numeric("value").notNull(),
  valid_until: timestamp("valid_until", { withTimezone: true }).notNull(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
