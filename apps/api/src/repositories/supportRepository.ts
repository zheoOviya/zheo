import { randomUUID } from "node:crypto";

// ============================================
// Support bounded-context repository (L15, Phase 4)
// Stores support tickets. VIP callers are routed to the specialized
// OPS_AGENT queue with HIGH priority.
// ============================================

export type TicketPriority = "LOW" | "MEDIUM" | "HIGH";
export const OPS_AGENT_ASSIGNEE = "OPS_AGENT";

export interface SupportTicket {
  id: string;
  user_id: string;
  subject: string;
  description: string;
  priority: TicketPriority;
  assignee: string | null;
  created_at: string;
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
      assignee: input.assignee,
      created_at: new Date().toISOString(),
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

  _reset(): void {
    this.tickets.clear();
  }
}
