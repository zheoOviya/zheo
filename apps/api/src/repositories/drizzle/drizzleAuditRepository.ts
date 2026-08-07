import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { audit_logs } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  AuditRepository,
  AuditLogEntry,
} from "../auditRepository";

// ============================================
// Audit context repository (Drizzle/Postgres)
// ============================================

export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: DrizzleDb) {}

  async log(
    actorId: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<AuditLogEntry> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(audit_logs).values({
      id,
      actor_id: actorId,
      action,
      metadata,
    });
    return {
      id,
      actor_id: actorId,
      action,
      metadata,
      created_at: now.toISOString(),
    };
  }

  async findByActor(
    actorId: string,
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    const rows = (await this.db
      .select()
      .from(audit_logs)
      .where(eq(audit_logs.actor_id, actorId))) as Record<string, unknown>[];
    return rows
      .map((row) => ({
        id: row.id as string,
        actor_id: row.actor_id as string,
        action: row.action as string,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        created_at: (row.created_at as Date).toISOString(),
      }))
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, limit);
  }

  async all(limit = 100): Promise<AuditLogEntry[]> {
    const rows = (await (this.db as unknown as {
      select: () => { from: (t: unknown) => Promise<unknown[]> };
    })
      .select()
      .from(audit_logs)) as Record<string, unknown>[];
    return rows
      .map((row) => ({
        id: row.id as string,
        actor_id: row.actor_id as string,
        action: row.action as string,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        created_at: (row.created_at as Date).toISOString(),
      }))
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, limit);
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
