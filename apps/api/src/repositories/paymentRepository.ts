import { randomUUID } from "node:crypto";

// ============================================
// Payments context repository (payments bounded context)
// ============================================

export type PaymentStatus = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "REFUNDED";

/**
 * Outcome of the latest reconciliation pass (PAYMENT_RECONCILIATION-A3).
 * Stored as text (not a DB enum) so new outcomes can be introduced without a
 * schema migration; the valid set is enforced here.
 */
export type PaymentReconciliationStatus =
  | "NONE"
  | "CONVERGED"
  | "RETRY"
  | "MANUAL_REVIEW"
  | "ERROR";

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
  gateway_status: string | null;
  reconciliation_status: PaymentReconciliationStatus;
  reconciliation_reason: string | null;
  manual_review: boolean;
  last_reconciled_at: string | null;
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

/**
 * Filter for the reconciliation sweep's candidate enumeration.
 *
 * No gateway call happens here: this only selects local rows that *may* need a
 * reconciliation pass. Order-convergence decisions (whether a CAPTURED row's
 * related order is actually converged) belong to the caller (PAY3-B), which is
 * why CAPTURED rows are only included when `includeCaptured` is set.
 */
export interface ReconciliationCandidateQuery {
  /** ISO timestamp: CREATED/FAILED rows created at or before this are stale. */
  staleBefore: string;
  /** Include CAPTURED rows (order convergence decided by the caller). */
  includeCaptured?: boolean;
  /** Max rows to return (default 100). */
  limit?: number;
}

/**
 * Partial reconciliation result. Omitted optional fields are left untouched so
 * a pass can record one fact without clobbering another.
 */
export interface ReconciliationResultUpdate {
  gateway_status?: string | null;
  reconciliation_status: PaymentReconciliationStatus;
  reconciliation_reason?: string | null;
  manual_review?: boolean;
  /** ISO timestamp of this reconciliation pass. */
  last_reconciled_at: string;
}

/**
 * Compare-and-set outcome. `NOOP_STATE_CHANGED` means the row exists but its
 * status no longer equals `expected`; no mutation is performed. `NOT_FOUND`
 * means no such row.
 */
export type CompareAndSetStatusResult =
  | { outcome: "UPDATED"; payment: PaymentDTO }
  | { outcome: "NOOP_STATE_CHANGED"; payment: PaymentDTO }
  | { outcome: "NOT_FOUND" };

export interface PaymentRepository {
  create(input: CreatePaymentInput): Promise<PaymentDTO>;
  getById(id: string): Promise<PaymentDTO | null>;
  getByGiftId(giftId: string): Promise<PaymentDTO | null>;
  getByOrderId(orderId: string): Promise<PaymentDTO | null>;
  findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null>;
  findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null>;
  updateWebhookResult(id: string, data: WebhookUpdate): Promise<PaymentDTO | null>;
  /**
   * Local candidate enumeration for the reconciliation sweep. Read-only; never
   * calls the gateway. Shared selector logic keeps Memory and Drizzle parity.
   */
  listReconciliationCandidates(query: ReconciliationCandidateQuery): Promise<PaymentDTO[]>;
  /** Records the durable outcome of a reconciliation pass (no status change). */
  markReconciliationResult(
    id: string,
    update: ReconciliationResultUpdate,
  ): Promise<PaymentDTO | null>;
  /**
   * Atomic status CAS. Only writes when the persisted status still equals
   * `expected`; a mismatch is a no-op. This is the only safe way for the
   * reconciliation engine to converge/flag a payment status.
   */
  compareAndSetStatus(
    id: string,
    expected: PaymentStatus,
    target: PaymentStatus,
  ): Promise<CompareAndSetStatusResult>;
  _reset(): void;
}

/**
 * Default and maximum sizes for a single reconciliation candidate page. The
 * repository boundary normalizes every request so a sweep can never read an
 * unbounded slice of the payments table.
 */
export const RECONCILIATION_CANDIDATE_LIMIT_DEFAULT = 100;
export const RECONCILIATION_CANDIDATE_LIMIT_MAX = 1000;

/**
 * Normalizes a caller-supplied candidate limit. Missing/non-finite/sub-1
 * values fall back to the default; genuinely huge values are clamped to the
 * maximum. Keeps Memory and Drizzle enumeration identical.
 */
export function normalizeCandidateLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return RECONCILIATION_CANDIDATE_LIMIT_DEFAULT;
  }
  const truncated = Math.trunc(limit);
  if (truncated < 1) return RECONCILIATION_CANDIDATE_LIMIT_DEFAULT;
  return Math.min(truncated, RECONCILIATION_CANDIDATE_LIMIT_MAX);
}

/**
 * Pure candidate-selection predicate shared by MemoryPaymentRepository and
 * DrizzlePaymentRepository so both backends enumerate identically.
 *
 * A row is a candidate when any of:
 *  - it is flagged for manual review
 *  - its last reconciliation outcome is MANUAL_REVIEW
 *  - it is CREATED/FAILED/REFUNDED and older than `staleBefore`
 *  - it is CAPTURED and `includeCaptured` is set
 */
export function selectReconciliationCandidates(
  payments: readonly PaymentDTO[],
  query: ReconciliationCandidateQuery,
): PaymentDTO[] {
  const limit = normalizeCandidateLimit(query.limit);
  const includeCaptured = query.includeCaptured ?? false;
  return payments
    .filter((payment) => {
      if (payment.manual_review) return true;
      if (payment.reconciliation_status === "MANUAL_REVIEW") return true;
      if (
        (payment.status === "CREATED" ||
          payment.status === "FAILED" ||
          payment.status === "REFUNDED") &&
        payment.created_at <= query.staleBefore
      ) {
        return true;
      }
      if (payment.status === "CAPTURED" && includeCaptured) return true;
      return false;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
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
      gateway_status: null,
      reconciliation_status: "NONE",
      reconciliation_reason: null,
      manual_review: false,
      last_reconciled_at: null,
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
    // A gift may have multiple payment rows (retries). Prefer the most recent
    // captured payment so refund lookups hit the row that actually carries a
    // razorpay_payment_id instead of a stale PENDING one.
    const matches = [...this.payments.values()].filter((p) => p.gift_id === giftId);
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const aCaptured = a.razorpay_payment_id ? 1 : 0;
      const bCaptured = b.razorpay_payment_id ? 1 : 0;
      if (aCaptured !== bCaptured) return bCaptured - aCaptured;
      return b.created_at.localeCompare(a.created_at);
    });
    return matches[0] ?? null;
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
    // Additive: only webhook-owned fields change. Reconciliation columns and
    // webhook_raw from prior passes survive untouched.
    const updated: PaymentDTO = {
      ...payment,
      ...data,
      updated_at: new Date().toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  async listReconciliationCandidates(
    query: ReconciliationCandidateQuery,
  ): Promise<PaymentDTO[]> {
    return selectReconciliationCandidates([...this.payments.values()], query);
  }

  async markReconciliationResult(
    id: string,
    update: ReconciliationResultUpdate,
  ): Promise<PaymentDTO | null> {
    const payment = this.payments.get(id);
    if (!payment) return null;
    const updated: PaymentDTO = {
      ...payment,
      reconciliation_status: update.reconciliation_status,
      last_reconciled_at: update.last_reconciled_at,
      updated_at: new Date().toISOString(),
    };
    if (update.gateway_status !== undefined) updated.gateway_status = update.gateway_status;
    if (update.reconciliation_reason !== undefined) {
      updated.reconciliation_reason = update.reconciliation_reason;
    }
    if (update.manual_review !== undefined) updated.manual_review = update.manual_review;
    this.payments.set(id, updated);
    return updated;
  }

  async compareAndSetStatus(
    id: string,
    expected: PaymentStatus,
    target: PaymentStatus,
  ): Promise<CompareAndSetStatusResult> {
    const payment = this.payments.get(id);
    if (!payment) return { outcome: "NOT_FOUND" };
    if (payment.status !== expected) {
      return { outcome: "NOOP_STATE_CHANGED", payment };
    }
    const updated: PaymentDTO = {
      ...payment,
      status: target,
      updated_at: new Date().toISOString(),
    };
    this.payments.set(id, updated);
    return { outcome: "UPDATED", payment: updated };
  }

  _reset(): void {
    this.payments.clear();
  }
}
