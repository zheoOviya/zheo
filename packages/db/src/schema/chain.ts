import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";

// ============================================
// Multi-outlet organization (V15, Phase 4)
// A chain groups multiple restaurant outlets under one owner.
// Each restaurant row carries an optional chain_id FK.
// ============================================

export const chains = pgTable(
  "chains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    owner_id: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerIdx: index("chains_owner_idx").on(table.owner_id),
  }),
);
