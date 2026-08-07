import {
  pgTable,
  text,
  boolean,
  doublePrecision,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const killSwitches = pgTable("kill_switches", {
  id: uuid("id").primaryKey().defaultRandom(),
  switch_name: text("switch_name").notNull().unique(),
  is_triggered: boolean("is_triggered").notNull().default(false),
  threshold_value: doublePrecision("threshold_value").notNull(),
  current_value: doublePrecision("current_value").notNull().default(0),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
