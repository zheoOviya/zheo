import type { OrderRepository, OrderDTO } from "../repositories/orderRepository";
import {
  type SupportRepository,
  OPS_AGENT_ASSIGNEE,
  type TicketPriority,
} from "../repositories/supportRepository";
import { createEventEnvelope, emit } from "../lib/eventBus";

// ============================================
// VIP tier calculation + ticket routing (L15, Phase 4)
// Support bounded context.
//
// VIP = order_count > VIP_ORDER_THRESHOLD  OR  total_spend > VIP_SPEND_THRESHOLD
// where only real fulfillment states count (DRAFT / PAYMENT_PENDING /
// PAYMENT_FAILED / CANCELLED / EXPIRED / REFUNDED / DISPUTED are excluded).
//
// VIP tickets: priority HIGH, auto-assigned to the specialized OPS_AGENT.
// Non-VIP tickets: priority MEDIUM, general queue (assignee null).
// ============================================

export const VIP_ORDER_THRESHOLD = 50;
export const VIP_SPEND_THRESHOLD = 5000;

export const NON_ELIGIBLE_VIP_STATUSES = new Set([
  "DRAFT",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
  "DISPUTED",
]);

export interface VipStatus {
  is_vip: boolean;
  order_count: number;
  total_spend: number;
  order_threshold: number;
  spend_threshold: number;
}

export interface CreatedTicket {
  id: string;
  user_id: string;
  subject: string;
  priority: TicketPriority;
  assignee: string | null;
  is_vip: boolean;
  created_at: string;
}

export class VipSupportService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly supportRepo: SupportRepository,
  ) {}

  computeVip(orders: OrderDTO[]): VipStatus {
    const eligible = orders.filter((o) => !NON_ELIGIBLE_VIP_STATUSES.has(o.status));
    const orderCount = eligible.length;
    const totalSpend = eligible.reduce(
      (sum, o) => sum + Number(o.total_amount),
      0,
    );
    return {
      is_vip: orderCount > VIP_ORDER_THRESHOLD || totalSpend > VIP_SPEND_THRESHOLD,
      order_count: orderCount,
      total_spend: Math.round(totalSpend * 100) / 100,
      order_threshold: VIP_ORDER_THRESHOLD,
      spend_threshold: VIP_SPEND_THRESHOLD,
    };
  }

  async getVipStatus(userId: string): Promise<VipStatus> {
    const orders = await this.orderRepo.getByUser(userId);
    return this.computeVip(orders);
  }

  async createTicket(
    userId: string,
    subject: string,
    description: string,
  ): Promise<CreatedTicket> {
    const orders = await this.orderRepo.getByUser(userId);
    const vip = this.computeVip(orders);

    const priority: TicketPriority = vip.is_vip ? "HIGH" : "MEDIUM";
    const assignee = vip.is_vip ? OPS_AGENT_ASSIGNEE : null;

    const ticket = await this.supportRepo.create({
      user_id: userId,
      subject,
      description,
      priority,
      assignee,
    });

    await emit(
      createEventEnvelope("VipTicketCreated", ticket.id, {
        ticket_id: ticket.id,
        user_id: userId,
        priority,
        assignee,
        is_vip: vip.is_vip,
      }),
    );

    return {
      id: ticket.id,
      user_id: ticket.user_id,
      subject: ticket.subject,
      priority: ticket.priority,
      assignee: ticket.assignee,
      is_vip: vip.is_vip,
      created_at: ticket.created_at,
    };
  }
}
