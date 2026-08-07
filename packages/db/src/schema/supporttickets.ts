import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", [
  "LOW",
  "MEDIUM",
  "HIGH",
]);

export const supportTicketStatusEnum = pgEnum("support_ticket_status", [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);

export const support_tickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").notNull(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    priority: supportTicketPriorityEnum("priority").notNull().default("MEDIUM"),
    status: supportTicketStatusEnum("status").notNull().default("OPEN"),
    assigned_to: text("assigned_to"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index("support_tickets_user_idx").on(table.user_id),
    statusIdx: index("support_tickets_status_idx").on(table.status),
    priorityIdx: index("support_tickets_priority_idx").on(table.priority),
  }),
);
