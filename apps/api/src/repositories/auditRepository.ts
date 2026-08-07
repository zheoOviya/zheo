import { randomUUID } from "node:crypto";

// ============================================
// Audit Repository (EGS Layer 2 Audit Trail)
// Records every vendor action into the shared
// in-memory store, mirroring the Drizzle
// `audit_logs` table (identity.ts).
// ============================================

export interface AuditLogEntry {
  id: string;
  actor_id: string;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditRepository {
  log(
    actorId: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<AuditLogEntry>;
  findByActor(actorId: string, limit?: number): Promise<AuditLogEntry[]>;
  all(limit?: number): Promise<AuditLogEntry[]>;
}

export class MemoryAuditRepository implements AuditRepository {
  private entries: AuditLogEntry[] = [];

  async log(
    actorId: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: randomUUID(),
      actor_id: actorId,
      action,
      metadata,
      created_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  async findByActor(actorId: string, limit = 50): Promise<AuditLogEntry[]> {
    return this.entries
      .filter((e) => e.actor_id === actorId)
      .slice(-limit)
      .reverse();
  }

  async all(limit = 100): Promise<AuditLogEntry[]> {
    return this.entries.slice(-limit).reverse();
  }

  /** Resets the store between tests. */
  _reset(): void {
    this.entries = [];
  }
}
