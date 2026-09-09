import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { support_tickets } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  SupportRepository,
  SupportTicket,
  TicketPriority,
  TicketStatus,
} from "../supportRepository";

// ============================================
// Support bounded-context repository (Drizzle/Postgres)
// Mirrors MemorySupportRepository semantics exactly.
// DB column `assigned_to` maps to the domain `assignee`.
// ============================================

export class DrizzleSupportRepository implements SupportRepository {
  constructor(private readonly db: DrizzleDb) {}

  private mapRow(row: Record<string, unknown>): SupportTicket {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      subject: row.subject as string,
      description: row.description as string,
      priority: row.priority as TicketPriority,
      status: row.status as TicketStatus,
      assignee: (row.assigned_to as string | null) ?? null,
      created_at: (row.created_at as Date).toISOString(),
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  async create(input: {
    user_id: string;
    subject: string;
    description: string;
    priority: TicketPriority;
    assignee: string | null;
  }): Promise<SupportTicket> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(support_tickets).values({
      id,
      user_id: input.user_id,
      subject: input.subject,
      description: input.description,
      priority: input.priority,
      status: "OPEN",
      assigned_to: input.assignee,
      created_at: now,
      updated_at: now,
    });
    return {
      id,
      user_id: input.user_id,
      subject: input.subject,
      description: input.description,
      priority: input.priority,
      status: "OPEN",
      assignee: input.assignee,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async getById(ticketId: string): Promise<SupportTicket | null> {
    const rows = (await this.db
      .select()
      .from(support_tickets)
      .where(eq(support_tickets.id, ticketId))) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]!);
  }

  async findByUser(userId: string): Promise<SupportTicket[]> {
    const rows = (await this.db
      .select()
      .from(support_tickets)
      .where(eq(support_tickets.user_id, userId))) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listAll(params: {
    page: number;
    limit: number;
    status?: TicketStatus;
    priority?: TicketPriority;
  }): Promise<{ items: SupportTicket[]; total: number }> {
    const conditions: ReturnType<typeof eq>[] = [];
    if (params.status) conditions.push(eq(support_tickets.status, params.status));
    if (params.priority) conditions.push(eq(support_tickets.priority, params.priority));
    const cond =
      conditions.length > 0 ? and(...conditions) : undefined;
    const rows = (await this.db
      .select()
      .from(support_tickets)
      .where(cond)) as Record<string, unknown>[];
    const all = rows
      .map((row) => this.mapRow(row))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = all.length;
    const offset = (params.page - 1) * params.limit;
    const items = all.slice(offset, offset + params.limit);
    return { items, total };
  }

  async update(
    ticketId: string,
    patch: { status?: TicketStatus; assignee?: string },
  ): Promise<SupportTicket | null> {
    const rows = (await this.db
      .select()
      .from(support_tickets)
      .where(eq(support_tickets.id, ticketId))) as Record<string, unknown>[];
    if (rows.length === 0) return null;

    const existing = this.mapRow(rows[0]!);
    const nextStatus = patch.status !== undefined ? patch.status : existing.status;
    const nextAssignee = patch.assignee !== undefined ? patch.assignee : existing.assignee;
    const now = new Date();

    const values: Record<string, unknown> = { updated_at: now };
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.assignee !== undefined) values.assigned_to = patch.assignee;
    await this.db
      .update(support_tickets)
      .set(values)
      .where(eq(support_tickets.id, ticketId));

    return {
      ...existing,
      status: nextStatus,
      assignee: nextAssignee,
      updated_at: now.toISOString(),
    };
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests use Memory repos.
  }
}
