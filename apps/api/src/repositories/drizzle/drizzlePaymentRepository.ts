import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { payments } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  PaymentRepository,
  PaymentDTO,
  CreatePaymentInput,
  WebhookUpdate,
  PaymentStatus,
} from "../paymentRepository";

// ============================================
// Payments context repository (Drizzle/Postgres)
// ============================================

function mapPaymentRow(row: Record<string, unknown>): PaymentDTO {
  const meta = (row.metadata as Record<string, unknown>) ?? {};
  return {
    id: row.id as string,
    order_id: (row.order_id as string | null) ?? null,
    gift_id: (row.gift_id as string | null) ?? null,
    razorpay_order_id: row.provider_transaction_id as string,
    razorpay_payment_id: (meta.razorpay_payment_id as string) ?? null,
    amount: Number(row.amount),
    currency: (meta.currency as string) ?? "INR",
    status: row.status as PaymentStatus,
    method: (meta.method as string) ?? null,
    webhook_event: (meta.webhook_event as string) ?? null,
    webhook_raw: (meta.webhook_raw as unknown) ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.created_at as Date).toISOString(),
  };
}

export class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreatePaymentInput): Promise<PaymentDTO> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(payments).values({
      id,
      order_id: input.order_id ?? null,
      gift_id: input.gift_id ?? null,
      provider: "razorpay",
      provider_transaction_id: input.razorpay_order_id,
      amount: String(input.amount),
      status: "CREATED",
      metadata: {
        currency: input.currency ?? "INR",
      },
    });
    return {
      id,
      order_id: input.order_id ?? null,
      gift_id: input.gift_id ?? null,
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: null,
      amount: input.amount,
      currency: input.currency ?? "INR",
      status: "CREATED",
      method: null,
      webhook_event: null,
      webhook_raw: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null> {
    // razorpay_payment_id is stored inside metadata jsonb.
    // Scan all payments and match the metadata field in-memory.
    const allRows = (await (
      this.db as unknown as {
        select: () => { from: (t: unknown) => Promise<unknown[]> };
      }
    )
      .select()
      .from(payments)) as Record<string, unknown>[];
    for (const row of allRows) {
      const dto = mapPaymentRow(row);
      if (dto.razorpay_payment_id === razorpayPaymentId) return dto;
    }
    return null;
  }

  async findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.provider_transaction_id, razorpayOrderId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  async getById(id: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id))) as Record<string, unknown>[];
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async getByGiftId(giftId: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.gift_id, giftId))) as Record<string, unknown>[];
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async getByOrderId(orderId: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.order_id, orderId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  async updateWebhookResult(id: string, data: WebhookUpdate): Promise<PaymentDTO | null> {
    await this.db
      .update(payments)
      .set({
        status: data.status,
        metadata: {
          razorpay_payment_id: data.razorpay_payment_id,
          method: data.method,
          webhook_event: data.webhook_event,
          webhook_raw: data.webhook_raw,
        },
      })
      .where(eq(payments.id, id));
    return this.findByPaymentId(id);
  }

  private async findByPaymentId(paymentId: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapPaymentRow(row) : null;
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
