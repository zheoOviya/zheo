import { randomUUID } from "node:crypto";

// ============================================
// Payments context repository (payments bounded context)
// ============================================

export type PaymentStatus = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED";

export interface PaymentDTO {
  id: string;
  order_id: string | null;
  gift_id: string | null;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  method: string | null;
  webhook_event: string | null;
  webhook_raw: unknown;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentInput {
  order_id?: string | null;
  gift_id?: string | null;
  razorpay_order_id: string;
  amount: number;
  currency?: string;
  /** Payment method (upi | card | netbanking | wallet | cod). null until a webhook reports the real one. */
  method?: string;
}

export interface WebhookUpdate {
  razorpay_payment_id: string;
  status: PaymentStatus;
  method: string;
  webhook_event: string;
  webhook_raw: unknown;
}

export interface PaymentRepository {
  create(input: CreatePaymentInput): Promise<PaymentDTO>;
  getById(id: string): Promise<PaymentDTO | null>;
  getByGiftId(giftId: string): Promise<PaymentDTO | null>;
  getByOrderId(orderId: string): Promise<PaymentDTO | null>;
  findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null>;
  findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null>;
  updateWebhookResult(id: string, data: WebhookUpdate): Promise<PaymentDTO | null>;
  _reset(): void;
}

export class MemoryPaymentRepository implements PaymentRepository {
  private payments = new Map<string, PaymentDTO>();

  async create(input: CreatePaymentInput): Promise<PaymentDTO> {
    const now = new Date().toISOString();
    const payment: PaymentDTO = {
      id: randomUUID(),
      order_id: input.order_id ?? null,
      gift_id: input.gift_id ?? null,
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: null,
      amount: input.amount,
      currency: input.currency ?? "INR",
      status: "CREATED",
      method: input.method ?? null,
      webhook_event: null,
      webhook_raw: null,
      created_at: now,
      updated_at: now,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null> {
    for (const p of this.payments.values()) {
      if (p.razorpay_payment_id === razorpayPaymentId) return p;
    }
    return null;
  }

  async findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null> {
    for (const p of this.payments.values()) {
      if (p.razorpay_order_id === razorpayOrderId) return p;
    }
    return null;
  }

  async getById(id: string): Promise<PaymentDTO | null> {
    return this.payments.get(id) ?? null;
  }

  async getByGiftId(giftId: string): Promise<PaymentDTO | null> {
    for (const p of this.payments.values()) {
      if (p.gift_id === giftId) return p;
    }
    return null;
  }

  async getByOrderId(orderId: string): Promise<PaymentDTO | null> {
    for (const p of this.payments.values()) {
      if (p.order_id === orderId) return p;
    }
    return null;
  }

  async updateWebhookResult(id: string, data: WebhookUpdate): Promise<PaymentDTO | null> {
    const payment = this.payments.get(id);
    if (!payment) return null;
    const updated: PaymentDTO = {
      ...payment,
      ...data,
      updated_at: new Date().toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  _reset(): void {
    this.payments.clear();
  }
}
