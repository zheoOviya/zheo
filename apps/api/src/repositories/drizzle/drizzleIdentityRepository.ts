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
    email: (row.email as string | null) ?? null,
    role: row.role as IdentityUser["role"],
    spice_tolerance: row.spice_tolerance as number | undefined,
    is_suspended: (row.is_suspended as boolean) ?? false,
    suspended_reason: (row.suspended_reason as string | null) ?? null,
    totp_secret: (row.totp_secret as string | null) ?? null,
    totp_enabled: (row.totp_enabled as boolean) ?? false,
    totp_confirmed_at: row.totp_confirmed_at
      ? (row.totp_confirmed_at as Date).toISOString()
      : null,
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

  async getByEmail(email: string): Promise<IdentityUser | null> {
    const rows = (await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))) as Record<string, unknown>[];
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
      totp_enabled: false,
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

  async setTotpSecret(userId: string, secret: string): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ totp_secret: secret })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  async enableTotp(userId: string): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({ totp_enabled: true, totp_confirmed_at: new Date() })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  async disableTotp(userId: string): Promise<IdentityUser | null> {
    await this.db
      .update(users)
      .set({
        totp_enabled: false,
        totp_secret: null,
        totp_confirmed_at: null,
      })
      .where(eq(users.id, userId));
    return this.getById(userId);
  }

  _seed(user: IdentityUser): void {
    this.db.insert(users).values({
      id: user.id,
      phone: user.phone,
      email: user.email ?? null,
      role: user.role,
      spice_tolerance: user.spice_tolerance ?? 3,
      is_suspended: user.is_suspended ?? false,
      totp_secret: user.totp_secret ?? null,
      totp_enabled: user.totp_enabled ?? false,
    }).catch((err) => {
      logger.warn({ message: "identity_seed_failed", error: err instanceof Error ? err.message : String(err) });
    });
  }

  _reset(): void {}
}
