import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import { logger } from "../../lib/logger";
import type {
  IdentityRepository,
  IdentityUser,
} from "../identityRepository";

// ============================================
// Identity context repository (Drizzle/Postgres)
// Sprint 5.2: Added is_suspended, listAll, suspend, reactivate
// ============================================

function mapRow(row: Record<string, unknown>): IdentityUser {
  return {
    id: row.id as string,
    phone: row.phone as string,
    role: row.role as IdentityUser["role"],
    spice_tolerance: row.spice_tolerance as number | undefined,
    is_suspended: (row.is_suspended as boolean) ?? false,
    suspended_reason: (row.suspended_reason as string | null) ?? null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export class DrizzleIdentityRepository implements IdentityRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getById(id: string): Promise<IdentityUser | null> {
    const rows = (await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async getByPhone(phone: string): Promise<IdentityUser | null> {
    const rows = (await this.db
      .select()
      .from(users)
      .where(eq(users.phone, phone))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async ensureByPhone(
    phone: string,
    role: IdentityUser["role"] = "CONSUMER",
  ): Promise<IdentityUser> {
    const rows = (await this.db
      .select()
      .from(users)
      .where(eq(users.phone, phone))) as Record<string, unknown>[];
    const row = rows[0];
    if (row) return mapRow(row);
    const newId = randomUUID();
    await this.db.insert(users).values({
      id: newId,
      phone,
      role,
    });
    return {
      id: newId,
      phone,
      role,
      is_suspended: false,
      created_at: new Date().toISOString(),
    };
  }

  async updateSpiceTolerance(
    userId: string,
    tolerance: number,
  ): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ spice_tolerance: tolerance })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  async listAll(page: number, limit: number, searchPhone?: string): Promise<{ items: IdentityUser[]; total: number }> {
    const allRows = (await this.db
      .select()
      .from(users)
      .where(undefined!)) as Record<string, unknown>[];
    let filtered = searchPhone
      ? allRows.filter((r) => (r.phone as string).includes(searchPhone))
      : allRows;
    filtered.sort((a, b) =>
      (b.created_at as Date).getTime() - (a.created_at as Date).getTime(),
    );
    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit).map(mapRow);
    return { items, total };
  }

  async suspend(userId: string): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ is_suspended: true })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  async reactivate(userId: string): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ is_suspended: false })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  async updateRole(userId: string, role: IdentityUser["role"]): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ role })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  _seed(user: IdentityUser): void {
    this.db.insert(users).values({
      id: user.id,
      phone: user.phone,
      role: user.role,
      spice_tolerance: user.spice_tolerance ?? 3,
      is_suspended: user.is_suspended ?? false,
    }).catch((err) => {
      logger.warn({ message: "identity_seed_failed", error: err instanceof Error ? err.message : String(err) });
    });
  }

  _reset(): void {}
}
