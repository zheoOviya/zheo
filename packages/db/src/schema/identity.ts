import { sql } from "drizzle-orm";
import {
  boolean,
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

export const userRoleEnum = pgEnum("user_role", [
  "CONSUMER",
  "VENDOR_OWNER",
  "VENDOR_STAFF",
  "OPS_AGENT",
  "ADMIN",
  "SUPER_ADMIN",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    /** Admin console login identifier (nullable for consumer/vendor users). */
    email: text("email"),
    spice_tolerance: integer("spice_tolerance").notNull().default(3),
    role: userRoleEnum("role").notNull().default("CONSUMER"),
    is_suspended: boolean("is_suspended").notNull().default(false),
    suspended_reason: text("suspended_reason"),
    /** TOTP 2FA (authenticator app). Secret stored base32-encoded. */
    totp_secret: text("totp_secret"),
    totp_enabled: boolean("totp_enabled").notNull().default(false),
    totp_confirmed_at: timestamp("totp_confirmed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    phoneIdx: uniqueIndex("users_phone_idx").on(table.phone),
    emailIdx: uniqueIndex("users_email_idx").on(table.email),
  }),
);

export const audit_logs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor_id: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    actorIdx: index("audit_logs_actor_idx").on(table.actor_id),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.created_at),
  }),
);
