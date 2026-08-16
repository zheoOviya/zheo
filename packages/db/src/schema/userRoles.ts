import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity";

// ============================================
// Scoped roles (multi-restaurant / franchise RBAC)
// `users.role` remains the platform-level default; `user_roles` carries
// per-scope membership so a user can own/staff multiple restaurants or a
// whole chain without a global role change. Scope types:
//   - platform   -> scope_id NULL (global role overrides)
//   - chain      -> scope_id = chains.id
//   - restaurant -> scope_id = restaurants.id
// ============================================

export const userRoleScopeEnum = pgEnum("user_role_scope", [
  "platform",
  "chain",
  "restaurant",
]);

export const user_roles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id),
    scope_type: userRoleScopeEnum("scope_type").notNull(),
    scope_id: uuid("scope_id"),
    role: text("role").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    scopeIdx: index("user_roles_scope_idx").on(table.scope_type, table.scope_id),
    userIdx: index("user_roles_user_idx").on(table.user_id),
    uniqueMembershipIdx: uniqueIndex("user_roles_membership_idx").on(
      table.user_id,
      table.scope_type,
      table.scope_id,
    ),
  }),
);
