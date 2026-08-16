import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { user_roles } from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// Scoped roles repository (multi-restaurant / franchise RBAC)
// Per-scope membership so a user can own/staff multiple restaurants or a
// whole chain without changing their global `users.role`.
// ============================================

export type UserRoleScopeType = "platform" | "chain" | "restaurant";

export interface UserRoleDTO {
  id: string;
  user_id: string;
  scope_type: UserRoleScopeType;
  scope_id: string | null;
  role: string;
  created_at: string;
}

export interface AssignUserRoleInput {
  user_id: string;
  scope_type: UserRoleScopeType;
  scope_id: string | null;
  role: string;
}

export interface UserRoleRepository {
  assign(input: AssignUserRoleInput): Promise<UserRoleDTO>;
  findByUser(userId: string): Promise<UserRoleDTO[]>;
  findByScope(scopeType: UserRoleScopeType, scopeId: string | null): Promise<UserRoleDTO[]>;
  isMember(userId: string, scopeType: UserRoleScopeType, scopeId: string | null): Promise<boolean>;
  _seed(dto: UserRoleDTO): void;
  _reset(): void;
}

export class MemoryUserRoleRepository implements UserRoleRepository {
  private readonly items = new Map<string, UserRoleDTO>();

  private findByKey(
    userId: string,
    scopeType: UserRoleScopeType,
    scopeId: string | null,
  ): UserRoleDTO | undefined {
    return Array.from(this.items.values()).find(
      (r) => r.user_id === userId && r.scope_type === scopeType && r.scope_id === scopeId,
    );
  }

  async assign(input: AssignUserRoleInput): Promise<UserRoleDTO> {
    const existing = this.findByKey(input.user_id, input.scope_type, input.scope_id);
    if (existing) {
      const updated = { ...existing, role: input.role };
      this.items.set(updated.id, updated);
      return updated;
    }
    const dto: UserRoleDTO = {
      id: randomUUID(),
      user_id: input.user_id,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      role: input.role,
      created_at: new Date().toISOString(),
    };
    this.items.set(dto.id, dto);
    return dto;
  }

  async findByUser(userId: string): Promise<UserRoleDTO[]> {
    return Array.from(this.items.values()).filter((r) => r.user_id === userId);
  }

  async findByScope(scopeType: UserRoleScopeType, scopeId: string | null): Promise<UserRoleDTO[]> {
    return Array.from(this.items.values()).filter(
      (r) => r.scope_type === scopeType && r.scope_id === scopeId,
    );
  }

  async isMember(
    userId: string,
    scopeType: UserRoleScopeType,
    scopeId: string | null,
  ): Promise<boolean> {
    return this.findByKey(userId, scopeType, scopeId) !== undefined;
  }

  _seed(dto: UserRoleDTO): void {
    this.items.set(dto.id, dto);
  }

  _reset(): void {
    this.items.clear();
  }
}

export class DrizzleUserRoleRepository implements UserRoleRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRow(row: Record<string, unknown>): UserRoleDTO {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      scope_type: row.scope_type as UserRoleScopeType,
      scope_id: (row.scope_id as string | null) ?? null,
      role: row.role as string,
      created_at: (row.created_at as Date).toISOString(),
    };
  }

  private scopeCond(scopeId: string | null) {
    return scopeId === null ? isNull(user_roles.scope_id) : eq(user_roles.scope_id, scopeId);
  }

  private whereKey(userId: string, scopeType: UserRoleScopeType, scopeId: string | null) {
    return and(
      eq(user_roles.user_id, userId),
      eq(user_roles.scope_type, scopeType),
      this.scopeCond(scopeId),
    );
  }

  async assign(input: AssignUserRoleInput): Promise<UserRoleDTO> {
    const id = randomUUID();
    const now = new Date();
    const existing = (await this.db
      .select()
      .from(user_roles)
      .where(this.whereKey(input.user_id, input.scope_type, input.scope_id))) as Record<string, unknown>[];

    if (existing.length > 0) {
      const row = this.mapRow(existing[0]!);
      await this.db
        .update(user_roles)
        .set({ role: input.role })
        .where(eq(user_roles.id, row.id));
      return { ...row, role: input.role };
    }

    await this.db.insert(user_roles).values({
      id,
      user_id: input.user_id,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      role: input.role,
    });
    return {
      id,
      user_id: input.user_id,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      role: input.role,
      created_at: now.toISOString(),
    };
  }

  async findByUser(userId: string): Promise<UserRoleDTO[]> {
    const rows = (await this.db
      .select()
      .from(user_roles)
      .where(eq(user_roles.user_id, userId))) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  async findByScope(scopeType: UserRoleScopeType, scopeId: string | null): Promise<UserRoleDTO[]> {
    const rows = (await this.db
      .select()
      .from(user_roles)
      .where(
        and(eq(user_roles.scope_type, scopeType), this.scopeCond(scopeId)),
      )) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  async isMember(
    userId: string,
    scopeType: UserRoleScopeType,
    scopeId: string | null,
  ): Promise<boolean> {
    const rows = (await this.db
      .select()
      .from(user_roles)
      .where(this.whereKey(userId, scopeType, scopeId))) as Record<string, unknown>[];
    return rows.length > 0;
  }

  _seed(_dto: UserRoleDTO): void {}

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
