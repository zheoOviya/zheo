import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

// ============================================
// Notification outbox (transactional messaging)
// Notifications are enqueued here by event subscribers and drained
// best-effort. This decouples vendor-approval state changes from SMS/email
// delivery: an entry persists even if the immediate send fails, so a retry
// (sweeper/cron) can replay it without re-reading the source of truth.
// ============================================

export const notificationStatusEnum = pgEnum("notification_status", [
  "PENDING",
  "SENT",
  "FAILED",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: text("channel").notNull(), // 'sms' | 'email'
    to_address: text("to_address").notNull(),
    body: text("body").notNull(),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusNextIdx: index("notifications_status_next_idx").on(
      table.status,
      table.next_attempt_at,
    ),
    userIdx: index("notifications_user_idx").on(table.user_id),
    // Bounded ordered reads over the pending backlog (OPER_2 inspection and
    // OPER_5 drain) sort by (created_at, id) after filtering status=PENDING.
    // A partial index lets those reads avoid a sort without paying for
    // terminal rows, which dominate a drained outbox.
    pendingCreatedIdIdx: index("notifications_pending_created_id_idx")
      .on(table.created_at, table.id)
      .where(sql`${table.status} = 'PENDING'`),
  }),
);
