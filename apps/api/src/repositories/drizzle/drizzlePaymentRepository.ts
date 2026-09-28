import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, type SQL } from "drizzle-orm";
import { payments } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  PaymentRepository,
  PaymentDTO,
  PaymentReconciliationStatus,
  CreatePaymentInput,
  WebhookUpdate,
  PaymentStatus,
  ReconciliationCandidateQuery,
  ReconciliationResultUpdate,
  CompareAndSetStatusResult,
  StatusConvergencePatch,
} from "../paymentRepository";
import { normalizeCandidateLimit } from "../paymentRepository";

// ============================================
// Payments context repository (Drizzle/Postgres)
// ============================================

/**
 * Drizzle update chain result exposing `.returning()`. The shared `DrizzleDb`
 * type only models the awaited form, so CAS paths cast the chain (same pattern
 * as drizzleOrderRepository).
 */
type ReturningUpdate = {
  returning: () => Promise<unknown[]>;
};

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
    gateway_status: (row.gateway_status as string | null) ?? null,
    reconciliation_status:
      (row.reconciliation_status as PaymentReconciliationStatus | null) ?? "NONE",
    reconciliation_reason: (row.reconciliation_reason as string | null) ?? null,
    manual_review: (row.manual_review as boolean | null) ?? false,
    last_reconciled_at: row.last_reconciled_at
      ? (row.last_reconciled_at as Date).toISOString()
      : null,
    created_at: (row.created_at as Date).toISOString(),
    // Real update timestamp; legacy rows with no updated_at fall back to
    // created_at so the DTO never lies about ordering.
    updated_at: row.updated_at
      ? (row.updated_at as Date).toISOString()
      : (row.created_at as Date).toISOString(),
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
      reconciliation_status: "NONE",
      manual_review: false,
      created_at: now,
      updated_at: now,
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
      gateway_status: null,
      reconciliation_status: "NONE",
      reconciliation_reason: null,
      manual_review: false,
      last_reconciled_at: null,
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
    // A gift may have multiple payment rows (retries). Prefer the most recent
    // captured payment (one that carries a razorpay_payment_id) so refund
    // lookups don't land on a stale PENDING row.
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.gift_id, giftId))) as Record<string, unknown>[];
    const sorted = rows
      .map((r) => mapPaymentRow(r))
      .sort((a, b) => {
        const aCaptured = a.razorpay_payment_id ? 1 : 0;
        const bCaptured = b.razorpay_payment_id ? 1 : 0;
        if (aCaptured !== bCaptured) return bCaptured - aCaptured;
        return b.created_at.localeCompare(a.created_at);
      });
    return sorted[0] ?? null;
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
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id))) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;

    // Additive metadata merge: preserve every existing key (e.g. currency and
    // the reconciliation-relevant webhook_raw from a prior pass) and only
    // overlay the webhook-owned fields. Reconciliation state lives in explicit
    // columns and is not touched here.
    const existingMetadata = (row.metadata as Record<string, unknown> | null) ?? {};
    await this.db
      .update(payments)
      .set({
        status: data.status,
        metadata: {
          ...existingMetadata,
          razorpay_payment_id: data.razorpay_payment_id,
          method: data.method,
          webhook_event: data.webhook_event,
          webhook_raw: data.webhook_raw,
        },
        updated_at: new Date(),
      })
      .where(eq(payments.id, id));
    return this.findByPaymentId(id);
  }

  /**
   * DB-side candidate predicate. Mirrors `selectReconciliationCandidates` but
   * runs in Postgres so the sweep never materializes the whole payments table:
   *   manual_review = true
   *   OR reconciliation_status = 'MANUAL_REVIEW'
   *   OR (status IN ('CREATED','FAILED','REFUNDED') AND created_at <= staleBefore)
   *   OR (includeCaptured AND status = 'CAPTURED')
   */
  private candidateCondition(query: ReconciliationCandidateQuery): SQL<unknown> {
    const reconcilableStatuses: PaymentStatus[] = ["CREATED", "FAILED", "REFUNDED"];
    const clauses: SQL<unknown>[] = [
      eq(payments.manual_review, true),
      eq(payments.reconciliation_status, "MANUAL_REVIEW"),
      and(
        inArray(payments.status, reconcilableStatuses),
        lte(payments.created_at, new Date(query.staleBefore)),
      )!,
    ];
    if (query.includeCaptured) {
      clauses.push(eq(payments.status, "CAPTURED"));
    }
    return or(...clauses)!;
  }

  async listReconciliationCandidates(
    query: ReconciliationCandidateQuery,
  ): Promise<PaymentDTO[]> {
    // Filtering, ordering and limiting all happen in Postgres. Only the
    // requested page of candidates is returned to the process; there is no
    // select-all-then-filter path.
    const limit = normalizeCandidateLimit(query.limit);
    const rows = (await (this.db
      .select()
      .from(payments)
      .where(this.candidateCondition(query)) as unknown as {
      orderBy: (column: unknown) => { limit: (n: number) => Promise<unknown[]> };
    })
      .orderBy(asc(payments.created_at))
      .limit(limit)) as Record<string, unknown>[];
    return rows.map(mapPaymentRow);
  }

  async markReconciliationResult(
    id: string,
    update: ReconciliationResultUpdate,
  ): Promise<PaymentDTO | null> {
    const current = await this.findByPaymentId(id);
    if (!current) return null;

    const values: Record<string, unknown> = {
      reconciliation_status: update.reconciliation_status,
      last_reconciled_at: new Date(update.last_reconciled_at),
      updated_at: new Date(),
    };
    if (update.gateway_status !== undefined) values.gateway_status = update.gateway_status;
    if (update.reconciliation_reason !== undefined) {
      values.reconciliation_reason = update.reconciliation_reason;
    }
    if (update.manual_review !== undefined) values.manual_review = update.manual_review;

    await this.db.update(payments).set(values).where(eq(payments.id, id));
    return this.findByPaymentId(id);
  }

  async compareAndSetStatus(
    id: string,
    expected: PaymentStatus,
    target: PaymentStatus,
    patch?: StatusConvergencePatch,
  ): Promise<CompareAndSetStatusResult> {
    const currentRow = await this.findRawRow(id);
    if (!currentRow) return { outcome: "NOT_FOUND" };
    const current = mapPaymentRow(currentRow);
    if (current.status !== expected) {
      return { outcome: "NOOP_STATE_CHANGED", payment: current };
    }

    const values: Record<string, unknown> = {
      status: target,
      updated_at: new Date(),
    };
    if (patch) {
      if (patch.gateway_status !== undefined) values.gateway_status = patch.gateway_status;
      if (patch.razorpay_payment_id !== undefined || patch.method !== undefined) {
        // Additive metadata merge: preserve currency/webhook_raw and only
        // overlay the gateway identity owned by the reconciliation CAS.
        const meta = { ...((currentRow.metadata as Record<string, unknown> | null) ?? {}) };
        if (patch.razorpay_payment_id !== undefined) {
          meta.razorpay_payment_id = patch.razorpay_payment_id;
        }
        if (patch.method !== undefined) meta.method = patch.method;
        values.metadata = meta;
      }
    }

    // Atomic guard: the DB predicate (id AND status = expected) is the source
    // of truth, so a concurrent writer that moved the status first loses.
    const updated = (await (this.db
      .update(payments)
      .set(values)
      .where(
        and(eq(payments.id, id), eq(payments.status, expected)),
      ) as unknown as ReturningUpdate).returning()) as Record<string, unknown>[];
    if (!updated[0]) {
      const after = await this.findByPaymentId(id);
      return after
        ? { outcome: "NOOP_STATE_CHANGED", payment: after }
        : { outcome: "NOT_FOUND" };
    }
    const after = await this.findByPaymentId(id);
    return { outcome: "UPDATED", payment: after ?? current };
  }

  private async findRawRow(paymentId: string): Promise<Record<string, unknown> | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))) as Record<string, unknown>[];
    return rows[0] ?? null;
  }

  private async findByPaymentId(paymentId: string): Promise<PaymentDTO | null> {
    const row = await this.findRawRow(paymentId);
    return row ? mapPaymentRow(row) : null;
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
