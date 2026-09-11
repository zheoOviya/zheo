import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { custom_roles } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import { AppError } from "../../middleware/envelope";
import type { CustomRole, RoleRepository } from "../roleRepository";

// ============================================
// Custom role catalog (admin console) - Drizzle/Postgres.
//
// Mirrors MemoryRoleRepository semantics exactly: `create` mints the row and
// returns the full CustomRole; `list` returns rows ordered by name ascending;
// `remove` returns true only when a row was actually deleted. The DB is the
// final arbiter for name uniqueness (custom_roles_name_uq); a concurrent
// duplicate is translated to the same CONFLICT/409 the route pre-check emits,
// while every unrelated error is rethrown unchanged.
// ============================================

const ROLE_NAME_UQ_CONSTRAINT = "custom_roles_name_uq";

/** Walks the error cause chain to the Postgres SQLSTATE + constraint name. */
function pgErrorDetails(err: unknown): { code?: string; constraint?: string } {
  let cur = err as
    | { code?: unknown; constraint?: unknown; cause?: unknown }
    | undefined;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (typeof cur.code === "string") {
      return {
        code: cur.code,
        constraint: typeof cur.constraint === "string" ? cur.constraint : undefined,
      };
    }
    cur = cur.cause as typeof cur;
  }
  return {};
}

/** Drizzle's query-builder surface is not widened by the shared DrizzleDb
 *  facade, so `DELETE ... RETURNING` is reached through a narrow local type
 *  instead of a broad cast (same approach as groupCart's upsert type). */
type ReturningDelete = Promise<unknown[]> & {
  returning: (columns: Record<string, unknown>) => Promise<unknown[]>;
};

export class DrizzleRoleRepository implements RoleRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRole(row: Record<string, unknown>): CustomRole {
    return {
      id: row.id as string,
      name: row.name as string,
      label: row.label as string,
      description: row.description as string,
      permissions: (row.permissions as string[] | null) ?? [],
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  private async rows(rowsPromise: unknown): Promise<Record<string, unknown>[]> {
    return (await rowsPromise) as Record<string, unknown>[];
  }

  async create(input: {
    name: string;
    label: string;
    description: string;
    permissions: string[];
  }): Promise<CustomRole> {
    const id = randomUUID();
    const now = new Date();
    try {
      await this.db.insert(custom_roles).values({
        id,
        name: input.name,
        label: input.label,
        description: input.description,
        permissions: input.permissions,
        created_at: now,
      });
    } catch (err) {
      // Translate ONLY the role-name uniqueness race into the exact
      // service-level error; a concurrent duplicate must never surface as a
      // 500. Any other DB error is rethrown untouched.
      const e = pgErrorDetails(err);
      if (e.code === "23505" && e.constraint === ROLE_NAME_UQ_CONSTRAINT) {
        throw new AppError(
          "CONFLICT",
          `Role '${input.name}' already exists`,
          409,
        );
      }
      throw err;
    }
    return {
      id,
      name: input.name,
      label: input.label,
      description: input.description,
      permissions: input.permissions,
      created_at: now.toISOString(),
    };
  }

  async getByName(name: string): Promise<CustomRole | null> {
    const rows = await this.rows(
      this.db.select().from(custom_roles).where(eq(custom_roles.name, name)),
    );
    return rows.length > 0 ? this.mapRole(rows[0]!) : null;
  }

  async list(): Promise<CustomRole[]> {
    // DrizzleDb type doesn't expose orderBy; sort in memory (name ascending)
    // to preserve MemoryRoleRepository ordering exactly.
    const rows = await this.rows(
      this.db.select().from(custom_roles).where(undefined),
    );
    return rows
      .map((row) => this.mapRole(row))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string): Promise<boolean> {
    const deleted = await (
      this.db
        .delete(custom_roles)
        .where(eq(custom_roles.name, name)) as unknown as ReturningDelete
    ).returning({ id: custom_roles.id });
    return deleted.length > 0;
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
