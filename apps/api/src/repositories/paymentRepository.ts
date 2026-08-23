import { randomUUID } from "node:crypto";

// ============================================
// Payments context repository (payments bounded context)
// ============================================

export type PaymentStatus =
  | "INITIATING"
  | "FAILED_INITIATION"
  | "CREATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "REFUNDED";

// Monotonic ladder for webhook results. A webhook may only move a payment
// FORWARD on this ladder; CAPTURED/REFUNDED are terminal, so a late
// `payment.failed` can never downgrade a row that was already captured.
export const PAYMENT_STATUS_RANK: Record<PaymentStatus, number> = {
  INITIATING: 0,
  FAILED_INITIATION: 1,
  CREATED: 2,
  AUTHORIZED: 3,
  FAILED: 4,
  CAPTURED: 5,
  REFUNDED: 6,
};

export interface PaymentAttempt {
  seq: number;
  event: string;
  at: string;
  razorpay_payment_id?: string;
  reason?: string;
}

export interface PaymentDTO {
  id: string;
  order_id: string | null;
  gift_id: string | null;
  /** Provider (Razorpay) order id. NULL while the intent is being prepared. */
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  method: string | null;
  webhook_event: string | null;
  webhook_raw: unknown;
  attempts: PaymentAttempt[];
  /** Unique gateway receipt. Derived from the intent id so retries/takeovers reuse it. */
  receipt: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Thrown when the canonical payment intent for a target already exists.
 * Maps to Postgres error 23505 on the partial unique indexes
 * `payments_order_unique` / `payments_gift_unique`.
 */
export class PaymentTargetConflictError extends Error {
  constructor(target: "order" | "gift", targetId: string) {
    super(`Payment intent already exists for ${target} ${targetId}`);
    this.name = "PaymentTargetConflictError";
  }
}

export interface CreatePaymentInput {
  order_id?: string | null;
  gift_id?: string | null;
  amount: number;
  currency?: string;
  /** Payment method (upi | card | netbanking | wallet | cod). null until a webhook reports the real one. */
  method?: string;
  /** Provider receipt. Derived from the intent id: `pay_`/`gift_`/`cod_` + uuid (dashes stripped). */
  receipt: string;
  lease_owner: string;
  leaseTtlMs?: number;
}

export interface WebhookUpdate {
  razorpay_payment_id: string;
  status: PaymentStatus;
  method: string;
  webhook_event: string;
  webhook_raw: unknown;
}

export interface WebhookUpdateResult {
  payment: PaymentDTO | null;
  /** false when the update was skipped because the status is not forward-progressing. */
  applied: boolean;
}

export type LeaseAcquireResult =
  | { payment: PaymentDTO; acquired: true; reason: "acquired" }
  | {
      payment: PaymentDTO | null;
      acquired: false;
      reason: "not-found" | "settled" | "lease-held";
    };

export const DEFAULT_LEASE_TTL_MS = 30_000;

export interface PaymentRepository {
  /** Atomically reserves the single canonical payment intent for a target. */
  createReservation(input: CreatePaymentInput): Promise<PaymentDTO>;
  getById(id: string): Promise<PaymentDTO | null>;
  getByGiftId(giftId: string): Promise<PaymentDTO | null>;
  getByOrderId(orderId: string): Promise<PaymentDTO | null>;
  findByRazorpayPaymentId(razorpayPaymentId: string): Promise<PaymentDTO | null>;
  findByRazorpayOrderId(razorpayOrderId: string): Promise<PaymentDTO | null>;
  /**
   * CAS takeover of an in-flight (or failed-initiation) intent. Succeeds when
   * the intent is not yet finalized AND the lease is free/expired OR owned by
   * the caller. On success the intent is returned to INITIATING with the lease
   * re-registered to `owner`.
   */
  acquireLease(id: string, owner: string, ttlMs?: number): Promise<LeaseAcquireResult>;
  /**
   * CAS finalize of an initiation: records the provider txn id and moves the
   * intent to CREATED. Only succeeds when the txn id is still NULL (single
   * winner). Returns null on a lost race.
   */
  finalizeInitiation(
    id: string,
    providerTxnId: string,
    method?: string,
  ): Promise<PaymentDTO | null>;
  /**
   * CAS move an INITIATING (never finalized) intent to FAILED_INITIATION,
   * clearing the lease. Returns null on a lost race.
   */
  markFailedInitiation(id: string, reason: string): Promise<PaymentDTO | null>;
  /** Concurrency-safe append to metadata.attempts (no read-modify-write). */
  appendAttempt(
    id: string,
    attempt: Omit<PaymentAttempt, "seq" | "at">,
  ): Promise<PaymentDTO | null>;
  /**
   * Monotonic webhook result application. `applied` is false when the status
   * does not progress the monotonic ladder.
   */
  updateWebhookResult(id: string, data: WebhookUpdate): Promise<WebhookUpdateResult>;
  _reset(): void;
}

export class MemoryPaymentRepository implements PaymentRepository {
  private payments = new Map<string, PaymentDTO>();

  async createReservation(input: CreatePaymentInput): Promise<PaymentDTO> {
    const orderId = input.order_id ?? null;
    const giftId = input.gift_id ?? null;
    for (const p of this.payments.values()) {
      if (orderId && p.order_id === orderId) {
        throw new PaymentTargetConflictError("order", orderId);
      }
      if (giftId && p.gift_id === giftId) {
        throw new PaymentTargetConflictError("gift", giftId);
      }
    }
    const now = new Date().toISOString();
    const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const payment: PaymentDTO = {
      id: randomUUID(),
      order_id: orderId,
      gift_id: giftId,
      razorpay_order_id: null,
      razorpay_payment_id: null,
      amount: input.amount,
      currency: input.currency ?? "INR",
      status: "INITIATING",
      method: input.method ?? null,
      webhook_event: null,
      webhook_raw: null,
      attempts: [{ seq: 1, event: "initiation_started", at: now }],
      receipt: input.receipt,
      lease_owner: input.lease_owner,
      lease_expires_at: new Date(Date.now() + ttl).toISOString(),
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

  /** Test introspection: every row in the store. */
  async getAll(): Promise<PaymentDTO[]> {
    return Array.from(this.payments.values());
  }

  async acquireLease(id: string, owner: string, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<LeaseAcquireResult> {
    const payment = this.payments.get(id);
    if (!payment) return { payment: null, acquired: false, reason: "not-found" };
    if (payment.razorpay_order_id !== null || payment.status === "CREATED" || payment.status === "AUTHORIZED" || payment.status === "CAPTURED" || payment.status === "REFUNDED") {
      return { payment, acquired: false, reason: "settled" };
    }
    const expires = payment.lease_expires_at ? Date.parse(payment.lease_expires_at) : 0;
    const leaseActive = Number.isFinite(expires) && expires > Date.now();
    if (leaseActive && payment.lease_owner !== owner) {
      return { payment, acquired: false, reason: "lease-held" };
    }
    const now = new Date();
    const updated: PaymentDTO = {
      ...payment,
      status: "INITIATING",
      lease_owner: owner,
      lease_expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      updated_at: now.toISOString(),
    };
    this.payments.set(id, updated);
    return { payment: updated, acquired: true, reason: "acquired" };
  }

  async finalizeInitiation(
    id: string,
    providerTxnId: string,
    method?: string,
  ): Promise<PaymentDTO | null> {
    const payment = this.payments.get(id);
    if (!payment || payment.razorpay_order_id !== null || payment.status !== "INITIATING") {
      return null;
    }
    const now = new Date();
    const updated: PaymentDTO = {
      ...payment,
      razorpay_order_id: providerTxnId,
      status: "CREATED",
      method: method ?? payment.method,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: now.toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  async markFailedInitiation(id: string, reason: string): Promise<PaymentDTO | null> {
    const payment = this.payments.get(id);
    if (!payment || payment.razorpay_order_id !== null || payment.status !== "INITIATING") {
      return null;
    }
    const now = new Date();
    const attempts: PaymentAttempt[] = [
      ...payment.attempts,
      { seq: nextSeq(payment.attempts), event: "initiation_failed", at: now.toISOString(), reason },
    ];
    const updated: PaymentDTO = {
      ...payment,
      status: "FAILED_INITIATION",
      attempts,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: now.toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  async appendAttempt(
    id: string,
    attempt: Omit<PaymentAttempt, "seq" | "at">,
  ): Promise<PaymentDTO | null> {
    const payment = this.payments.get(id);
    if (!payment) return null;
    const updated: PaymentDTO = {
      ...payment,
      attempts: [...payment.attempts, { ...attempt, seq: nextSeq(payment.attempts), at: new Date().toISOString() }],
      updated_at: new Date().toISOString(),
    };
    this.payments.set(id, updated);
    return updated;
  }

  async updateWebhookResult(id: string, data: WebhookUpdate): Promise<WebhookUpdateResult> {
    const payment = this.payments.get(id);
    if (!payment) return { payment: null, applied: false };
    if (PAYMENT_STATUS_RANK[data.status] <= PAYMENT_STATUS_RANK[payment.status]) {
      return { payment, applied: false };
    }
    const now = new Date().toISOString();
    const attempts: PaymentAttempt[] = [
      ...payment.attempts,
      {
        seq: nextSeq(payment.attempts),
        event: data.webhook_event,
        at: now,
        razorpay_payment_id: data.razorpay_payment_id,
      },
    ];
    const updated: PaymentDTO = {
      ...payment,
      razorpay_payment_id: data.razorpay_payment_id,
      status: data.status,
      method: data.method,
      webhook_event: data.webhook_event,
      webhook_raw: data.webhook_raw,
      attempts,
      updated_at: now,
    };
    this.payments.set(id, updated);
    return { payment: updated, applied: true };
  }

  _reset(): void {
    this.payments.clear();
  }

  /**
   * Test-only: seeds a finalized payment DTO directly (bypassing the
   * reservation/finalize CAS flow) so tests can set up settled intents.
   */
  _seedFinalized(input: {
    order_id?: string | null;
    gift_id?: string | null;
    razorpay_order_id: string | null;
    razorpay_payment_id?: string | null;
    amount: number;
    currency?: string;
    status?: PaymentStatus;
    method?: string | null;
    receipt?: string;
    lease_owner?: string | null;
    lease_expires_at?: string | null;
  }): PaymentDTO {
    const now = new Date().toISOString();
    const payment: PaymentDTO = {
      id: randomUUID(),
      order_id: input.order_id ?? null,
      gift_id: input.gift_id ?? null,
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id ?? null,
      amount: input.amount,
      currency: input.currency ?? "INR",
      status: input.status ?? "CREATED",
      method: input.method ?? null,
      webhook_event: null,
      webhook_raw: null,
      attempts: [{ seq: 1, event: "seeded", at: now }],
      receipt: input.receipt ?? input.razorpay_order_id ?? "",
      lease_owner: input.lease_owner ?? null,
      lease_expires_at: input.lease_expires_at ?? null,
      created_at: now,
      updated_at: now,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }
}

function nextSeq(attempts: PaymentAttempt[]): number {
  return attempts.reduce((max, a) => Math.max(max, a.seq), 0) + 1;
}
