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

export interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
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

export class RazorpayService {
  // Offline-mock order registry. Mirrors Razorpay's uniqueness guarantee on
  // `receipt`: the same receipt can never mint a second order, and orders can
  // be reconciled by exact receipt. Test-only state, reset via
  // `_resetTestState`.
  private ordersByReceipt = new Map<string, RazorpayOrder>();
  private orderCreationCount = 0;
  private injectedCreateError: Error | null = null;

  async createOrder(amountInPaise: number, receipt: string): Promise<RazorpayOrder> {
    if (MOCK_MODE) {
      if (this.injectedCreateError) {
        const err = this.injectedCreateError;
        throw err;
      }
      if (this.ordersByReceipt.has(receipt)) {
        // Razorpay enforces unique receipts: a second order with the same
        // receipt is rejected. This is the second idempotency layer.
        throw new Error(`Razorpay order creation failed: 400 receipt ${receipt} already exists`);
      }
      const order: RazorpayOrder = {
        id: razorpayOrderId(),
        amount: amountInPaise,
        amount_paid: 0,
        currency: "INR",
        receipt,
        status: "created",
        created_at: Math.floor(Date.now() / 1000),
      };
      this.ordersByReceipt.set(receipt, order);
      this.orderCreationCount += 1;
      return order;
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

  /**
   * Reconciles a provider order by its exact receipt. In mock mode this
   * consults the in-process order registry; in production it queries the
   * Razorpay orders-list API filtered by receipt (Razorpay supports unique
   * receipts). Used to resolve ambiguous initiations (crash between provider
   * create and DB finalize) WITHOUT minting a duplicate order. Returns null
   * when the gateway has no record for the receipt, so the caller may create.
   */
  async fetchOrdersByReceipt(receipt: string): Promise<RazorpayOrder | null> {
    if (MOCK_MODE) {
      return this.ordersByReceipt.get(receipt) ?? null;
    }
    const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString(
      "base64",
    );
    const url = `https://api.razorpay.com/v1/orders?receipt=${encodeURIComponent(receipt)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      // 400 for an unknown/invalid receipt simply means "no such order".
      return null;
    }
    const body = (await res.json()) as {
      items?: { id: string; amount: number; currency: string; receipt: string; status: string }[];
    };
    const match = (body.items ?? []).find(
      (o) => o.receipt === receipt && o.currency === "INR",
    );
    if (!match) return null;
    return {
      id: match.id,
      amount: match.amount,
      amount_paid: 0,
      currency: match.currency,
      receipt: match.receipt,
      status: match.status,
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  /** Total provider orders minted (mock). Monotonic; reset via `_resetTestState`. */
  get createOrderCount(): number {
    return this.orderCreationCount;
  }

  /** Injects a failure for the next createOrder call (mock only). */
  _simulateCreateOrderError(error: Error | null): void {
    this.injectedCreateError = error;
  }

  /** Resets the mock registry and counters between tests. */
  _resetTestState(): void {
    this.ordersByReceipt.clear();
    this.orderCreationCount = 0;
    this.injectedCreateError = null;
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
      return { id: `refund_mock_${randomUUID().slice(0, 8)}`, status: "processed" };
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
    const payload = {
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: `refund_mock_${randomUUID().slice(0, 8)}`,
            payment_id: razorpayPaymentId,
            amount: amountInPaise,
            status: "processed",
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;
    return { payload, rawBody, signature };
  }

  buildMockWebhook(
    razorpayOrderId: string,
    amount: number,
    event: "payment.captured" | "payment.failed" | "payment.authorized" | "payment.pending",
    reason?: string,
  ): { payload: RazorpayWebhookPayload; rawBody: string; signature: string } {
    const paymentId = razorpayPaymentId();
    const statusMap: Record<string, string> = {
      "payment.captured": "captured",
      "payment.failed": "failed",
      "payment.authorized": "authorized",
      "payment.pending": "pending",
    };
    const payload: RazorpayWebhookPayload = {
      event,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: razorpayOrderId,
            amount,
            status: statusMap[event] ?? "pending",
            captured: event === "payment.captured",
            method: "upi",
            description: reason,
          },
        },
      },
    };

    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;
    return { payload, rawBody, signature };
  }
}

export const razorpayService = new RazorpayService();
