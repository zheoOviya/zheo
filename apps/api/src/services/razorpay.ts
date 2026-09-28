import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { config } from "../config";

// ============================================
// Razorpay Integration (PRD Phase 1, O04)
// Offline mock when NODE_ENV=test or no real keys.
// Production: uses Razorpay REST API for order creation
// and HMAC-SHA256 signature verification for webhooks.
// ============================================

export interface RazorpayOrder {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

// Normalized gateway-truth shapes returned by the read APIs (PAY3-B). They are
// deliberately narrower than the provider payloads so callers depend on a
// stable contract rather than the raw JSON.
export interface RazorpayOrderEntity {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
}

export interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  method: string | null;
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
}

/** Why a gateway read failed. Infrastructure failures are not gateway facts. */
export type RazorpayReadFailure = "network" | "provider";

/**
 * Raised when a gateway read fails for an infrastructure reason (network /
 * timeout) or the provider answered non-2xx. Distinguishable from a legitimate
 * gateway answer: an unknown entity is `null`, not an error.
 */
export class RazorpayReadError extends Error {
  constructor(
    readonly failure: RazorpayReadFailure,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "RazorpayReadError";
  }
}

export function isRazorpayReadError(err: unknown): err is RazorpayReadError {
  return err instanceof RazorpayReadError;
}

export interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        currency: string;
        status: string;
        captured: boolean;
        method: string;
        description?: string;
      };
    };
  };
}

const MOCK_MODE = config.env === "test" || !config.razorpay.keyId;

// Hard-fail in production when the gateway is unconfigured instead of silently
// accepting mock payments for real traffic.
if (config.env === "production" && (!config.razorpay.keyId || !config.razorpay.keySecret)) {
  throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are required in production");
}

/** True when the gateway is the offline mock (test/preview without real keys). */
export function isRazorpayMockMode(): boolean {
  return MOCK_MODE;
}

function razorpayOrderId(): string {
  return `order_mock_${randomUUID().slice(0, 8)}`;
}

function razorpayPaymentId(): string {
  return `pay_mock_${randomUUID().slice(0, 8)}`;
}

function toNumberOrZero(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Provider currency that is missing or not a non-empty string is fail-closed to
 * an explicit non-valid sentinel. It must NEVER be defaulted to "INR": doing so
 * would let a malformed payload be treated as valid Indian Rupee truth and pass
 * the PAY-4 integrity predicate.
 */
export const UNKNOWN_CURRENCY = "UNKNOWN";

function normalizedCurrency(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : UNKNOWN_CURRENCY;
}

function normalizeOrder(raw: unknown): RazorpayOrderEntity {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    amount: toNumberOrZero(r.amount),
    amount_paid: toNumberOrZero(r.amount_paid),
    currency: normalizedCurrency(r.currency),
    status: typeof r.status === "string" ? r.status : "unknown",
  };
}

export function normalizePayment(raw: unknown): RazorpayPaymentEntity {
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status : "unknown";
  return {
    id: String(r.id),
    order_id: typeof r.order_id === "string" ? r.order_id : "",
    amount: toNumberOrZero(r.amount),
    currency: normalizedCurrency(r.currency),
    status,
    captured: r.captured === true || status === "captured",
    method: toStringOrNull(r.method),
  };
}

export function normalizeRefund(raw: unknown): RazorpayRefundEntity {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    payment_id: typeof r.payment_id === "string" ? r.payment_id : "",
    amount: toNumberOrZero(r.amount),
    currency: normalizedCurrency(r.currency),
    status: typeof r.status === "string" ? r.status : "unknown",
  };
}

/** Razorpay collection endpoints wrap their rows in `{ items: [...] }`. */
function extractItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export class RazorpayService {
  // Offline ledger used only when MOCK_MODE is active (test / preview without
  // real keys). createOrder/buildMockWebhook/refund record into it so the
  // gateway-truth read APIs stay coherent without ever touching the network.
  private readonly mockOrders = new Map<string, RazorpayOrderEntity>();
  private readonly mockPayments = new Map<string, RazorpayPaymentEntity>();
  private readonly mockRefunds = new Map<string, RazorpayRefundEntity>();

  async createOrder(amountInPaise: number, receipt: string): Promise<RazorpayOrder> {
    if (MOCK_MODE) {
      const id = razorpayOrderId();
      this.mockOrders.set(id, {
        id,
        amount: amountInPaise,
        amount_paid: 0,
        currency: "INR",
        status: "created",
      });
      return {
        id,
        amount: amountInPaise,
        amount_paid: 0,
        currency: "INR",
        receipt,
        status: "created",
        created_at: Math.floor(Date.now() / 1000),
      };
    }

    const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString(
      "base64",
    );

    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: "INR",
        receipt,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay order creation failed: ${res.status} ${body}`);
    }

    return res.json();
  }

  // ==========================================
  // Gateway truth reads (PAY3-B)
  // Authenticated GETs that normalize provider payloads into stable shapes.
  // An unknown entity is `null`; a network/non-2xx failure throws
  // RazorpayReadError so infrastructure failure is never mistaken for a fact.
  // ==========================================

  private authHeader(): string {
    return `Basic ${Buffer.from(
      `${config.razorpay.keyId}:${config.razorpay.keySecret}`,
    ).toString("base64")}`;
  }

  private async getJson(path: string): Promise<unknown | null> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`https://api.razorpay.com${path}`, {
        method: "GET",
        headers: { Authorization: this.authHeader() },
      });
    } catch (err) {
      throw new RazorpayReadError(
        "network",
        null,
        `Razorpay read failed (network): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new RazorpayReadError(
        "provider",
        res.status,
        `Razorpay read failed: ${res.status} ${body}`,
      );
    }
    return res.json();
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPaymentEntity | null> {
    if (MOCK_MODE) return this.mockPayments.get(paymentId) ?? null;
    const raw = await this.getJson(`/v1/payments/${encodeURIComponent(paymentId)}`);
    return raw ? normalizePayment(raw) : null;
  }

  async fetchOrder(razorpayOrderId: string): Promise<RazorpayOrderEntity | null> {
    if (MOCK_MODE) {
      const order = this.mockOrders.get(razorpayOrderId);
      return order ? { ...order } : null;
    }
    const raw = await this.getJson(`/v1/orders/${encodeURIComponent(razorpayOrderId)}`);
    return raw ? normalizeOrder(raw) : null;
  }

  async fetchPaymentsForOrder(razorpayOrderId: string): Promise<RazorpayPaymentEntity[]> {
    if (MOCK_MODE) {
      return [...this.mockPayments.values()].filter((p) => p.order_id === razorpayOrderId);
    }
    const raw = await this.getJson(
      `/v1/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
    );
    return extractItems(raw).map(normalizePayment);
  }

  async fetchRefund(refundId: string): Promise<RazorpayRefundEntity | null> {
    if (MOCK_MODE) return this.mockRefunds.get(refundId) ?? null;
    const raw = await this.getJson(`/v1/refunds/${encodeURIComponent(refundId)}`);
    return raw ? normalizeRefund(raw) : null;
  }

  async fetchRefundsForPayment(paymentId: string): Promise<RazorpayRefundEntity[]> {
    if (MOCK_MODE) {
      return [...this.mockRefunds.values()].filter((r) => r.payment_id === paymentId);
    }
    const raw = await this.getJson(
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
    );
    return extractItems(raw).map(normalizeRefund);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (MOCK_MODE) {
      return signature.startsWith("valid_sig_");
    }

    const secret = config.razorpay.webhookSecret;
    if (!secret) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    return signature === expected;
  }

  async refund(paymentId: string, amountInPaise: number): Promise<{ id: string; status: string }> {
    if (MOCK_MODE) {
      const id = `refund_mock_${randomUUID().slice(0, 8)}`;
      this.mockRefunds.set(id, {
        id,
        payment_id: paymentId,
        amount: amountInPaise,
        currency: this.mockPayments.get(paymentId)?.currency ?? "INR",
        status: "processed",
      });
      return { id, status: "processed" };
    }
    const auth = Buffer.from(
      `${config.razorpay.keyId}:${config.razorpay.keySecret}`,
    ).toString("base64");
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: amountInPaise }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay refund failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  buildMockRefundWebhook(
    razorpayPaymentId: string,
    amountInPaise: number,
  ): { payload: { event: string; payload: { refund: { entity: { id: string; payment_id: string; amount: number; status: string } } } }; rawBody: string; signature: string } {
    const refundId = `refund_mock_${randomUUID().slice(0, 8)}`;
    const payload = {
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: refundId,
            payment_id: razorpayPaymentId,
            amount: amountInPaise,
            status: "processed",
          },
        },
      },
    };
    this.mockRefunds.set(refundId, {
      id: refundId,
      payment_id: razorpayPaymentId,
      amount: amountInPaise,
      currency: this.mockPayments.get(razorpayPaymentId)?.currency ?? "INR",
      status: "processed",
    });
    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;
    return { payload, rawBody, signature };
  }

  buildMockWebhook(
    razorpayOrderId: string,
    amount: number,
    event: "payment.captured" | "payment.failed",
    reason?: string,
  ): { payload: RazorpayWebhookPayload; rawBody: string; signature: string } {
    const paymentId = razorpayPaymentId();
    const payload: RazorpayWebhookPayload = {
      event,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: razorpayOrderId,
            amount,
            currency: "INR",
            status: event === "payment.captured" ? "captured" : "failed",
            captured: event === "payment.captured",
            method: "upi",
            description: reason,
          },
        },
      },
    };
    this.mockPayments.set(paymentId, {
      id: paymentId,
      order_id: razorpayOrderId,
      amount,
      currency: "INR",
      status: event === "payment.captured" ? "captured" : "failed",
      captured: event === "payment.captured",
      method: "upi",
    });

    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;
    return { payload, rawBody, signature };
  }
}

export const razorpayService = new RazorpayService();
