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

function razorpayOrderId(): string {
  return `order_mock_${randomUUID().slice(0, 8)}`;
}

function razorpayPaymentId(): string {
  return `pay_mock_${randomUUID().slice(0, 8)}`;
}

export class RazorpayService {
  async createOrder(amountInPaise: number, receipt: string): Promise<RazorpayOrder> {
    if (MOCK_MODE) {
      return {
        id: razorpayOrderId(),
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

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (MOCK_MODE) {
      return signature.startsWith("valid_sig_");
    }

    const secret = config.razorpay.webhookSecret;
    if (!secret) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    return signature === expected;
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
            status: event === "payment.captured" ? "captured" : "failed",
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
