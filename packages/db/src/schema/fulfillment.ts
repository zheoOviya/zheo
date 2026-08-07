import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { orders, orderStatusEnum } from "./ordering";

// Order status timeline - records every state transition to enforce
// the "No skipping" rule of the PRD Section 4 state machine.
export const order_status_history = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    order_id: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    from_status: orderStatusEnum("from_status"),
    to_status: orderStatusEnum("to_status").notNull(),
    transitioned_at: timestamp("transitioned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    note: text("note"),
  },
  (table) => ({
    orderIdx: index("order_status_history_order_idx").on(table.order_id),
  }),
);
