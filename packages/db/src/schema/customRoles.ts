import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================
// Custom role persistence (admin console role catalog).
//
// Custom roles are created by a SUPER_ADMIN and were previously held only in
// process memory, so they vanished on restart and were invisible across
// instances. This table makes the catalog durable. `name` is the natural key
// and the DB is the final arbiter for its uniqueness (collision -> 23505 on
// custom_roles_name_uq). Built-in roles stay static metadata in the API and
// are intentionally NOT seeded here. `users.role` remains a free string; no
// FK is added (see the accepted delete-vs-assign race limitation).
// ============================================

export const custom_roles = pgTable(
  "custom_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameUq: uniqueIndex("custom_roles_name_uq").on(table.name),
  }),
);
