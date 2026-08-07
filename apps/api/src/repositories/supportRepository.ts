import { randomUUID } from "node:crypto";

// ============================================
// Support bounded-context repository (L15, Phase 4 + Sprint 5.2)
// Stores support tickets. VIP callers are routed to the specialized
// OPS_AGENT queue with HIGH priority.
//
// Sprint 5.2: Added listAll, updateStatus, updateAssignee for admin
// support ticket oversight (A-07). Added status field.
// ============================================

export type TicketPriority = "LOW" | "MEDIUM" | "HIGH";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export const OPS_AGENT_ASSIGNEE = "OPS_AGENT";

export interface SupportTicket {
  id: string;
  user_id: string;
  subject: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportRepository {
  create(input: {
    user_id: string;
    subject: string;
    description: string;
    priority: TicketPriority;
    assignee: string | null;
  }): Promise<SupportTicket>;
  getById(ticketId: string): Promise<SupportTicket | null>;
  findByUser(userId: string): Promise<SupportTicket[]>;
  /** A-07: paginated listing with optional status/priority filters. */
  listAll(params: {
    page: number;
    limit: number;
    status?: TicketStatus;
    priority?: TicketPriority;
  }): Promise<{ items: SupportTicket[]; total: number }>;
  /** A-07: update ticket status and/or assignee. */
  update(ticketId: string, patch: { status?: TicketStatus; assignee?: string }): Promise<SupportTicket | null>;
  _reset(): void;
}

export class MemorySupportRepository implements SupportRepository {
  private readonly tickets = new Map<string, SupportTicket>();

  async create(input: {
    user_id: string;
    subject: string;
    description: string;
    priority: TicketPriority;
    assignee: string | null;
  }): Promise<SupportTicket> {
    const ticket: SupportTicket = {
      id: randomUUID(),
      user_id: input.user_id,
      subject: input.subject,
      description: input.description,
      priority: input.priority,
      status: "OPEN",
      assignee: input.assignee,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  async getById(ticketId: string): Promise<SupportTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async findByUser(userId: string): Promise<SupportTicket[]> {
    return Array.from(this.tickets.values())
      .filter((t) => t.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async listAll(params: {
    page: number;
    limit: number;
    status?: TicketStatus;
    priority?: TicketPriority;
  }): Promise<{ items: SupportTicket[]; total: number }> {
    let all = Array.from(this.tickets.values());
    if (params.status) all = all.filter((t) => t.status === params.status);
    if (params.priority) all = all.filter((t) => t.priority === params.priority);
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = all.length;
    const offset = (params.page - 1) * params.limit;
    const items = all.slice(offset, offset + params.limit);
    return { items, total };
  }

  async update(
    ticketId: string,
    patch: { status?: TicketStatus; assignee?: string },
  ): Promise<SupportTicket | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    if (patch.status !== undefined) ticket.status = patch.status;
    if (patch.assignee !== undefined) ticket.assignee = patch.assignee;
    ticket.updated_at = new Date().toISOString();
    return ticket;
  }

  _reset(): void {
    this.tickets.clear();
  }
}
