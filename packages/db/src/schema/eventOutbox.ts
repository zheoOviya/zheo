import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================
// Event outbox (durable transactional event delivery)
//
// EVT-A scope: schema + migration ONLY. This table makes it structurally
// possible for a future producer to commit a business mutation and the
// corresponding event_outbox INSERT in ONE database transaction (EVT-B). No
// producer is wired to this table yet, and no relay/sweeper reads it yet.
//
// Identity: `id` is the DB row identity; `event_id` is the durable event
// identity supplied by the event envelope and is NOT assumed to equal `id`.
//
// Lifecycle: only PENDING / CLAIMED / DEAD are encoded here. A successful
// delivery representation (e.g. SENT/PUBLISHED or row removal) is deliberately
// NOT encoded in this gate; EVT-B finalizes it with evidence.
//
// No foreign key is declared: the outbox serves every aggregate type, so it
// cannot reference a single business table.
// ============================================

export const eventOutboxStatusEnum = pgEnum("event_outbox_status", [
  "PENDING",
  "CLAIMED",
  "DEAD",
]);

export const event_outbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    event_id: uuid("event_id").notNull(),
    event_name: text("event_name").notNull(),
    // Not uuid: the EventBus accepts non-uuid aggregate ids (e.g. "discovery").
    aggregate_id: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata").notNull(),
    status: eventOutboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Durable event identity boundary: one outbox row per event_id.
    eventIdUq: uniqueIndex("event_outbox_event_id_uq").on(table.event_id),
    // Pending/retry scan: ordered, bounded reads over due work.
    statusNextIdx: index("event_outbox_status_next_idx").on(
      table.status,
      table.next_attempt_at,
    ),
  }),
);
