import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type { GiftRepository, GiftDTO } from "../repositories/giftRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import { submitGiftRefund } from "./gift";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";

export interface SweepResult {
  expired: number;
  refunded: number;
  failed: number;
}

/**
 * Daily expiry + refund sweep. Gifts that are ACTIVE/CLAIMED/PENDING past
 * their expires_at become EXPIRED. Paid gifts (payment CAPTURED, not yet
 * REFUNDED) move to REFUNDING and a Razorpay refund is submitted exactly
 * once (guarded by gifts.refund_requested_at). The gift only reaches
 * REFUNDED when the refund webhook confirms — except in mock/preview mode,
 * where it resolves immediately. Failed refund submissions keep no marker
 * and are retried on the next sweep.
 */
export async function runGiftExpirySweep(
  giftRepo: GiftRepository,
  paymentRepo: PaymentRepository,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, refunded: 0, failed: 0 };
  const due = await giftRepo.listDueForExpiry(now.toISOString());

  for (const gift of due) {
    try {
      // A gift already committed to an order is in flight: never expire or
      // refund it, or the recipient's ₹0 meal at pickup would be voided and
      // the sender double-paid.
      if (gift.redeemed_order_id) continue;

      if (gift.status === "ACTIVE" || gift.status === "CLAIMED" || gift.status === "PENDING") {
        await giftRepo.updateStatus(gift.id, "EXPIRED");
        result.expired += 1;
        await emit(
          createEventEnvelope("GiftExpired", gift.id, { gift_id: gift.id }),
        );
      }

      const payment = await paymentRepo.getByGiftId(gift.id);
      if (!payment) continue;
      // Only a captured payment can be refunded. FAILED payments carry a
      // razorpay_payment_id but were never charged, so refunding one would
      // invent money in mock mode and 400-loop in production.
      if (payment.status !== "CAPTURED") continue;
      // A refund was already submitted (or is being resolved); skip so we
      // never double-refund a gift whose webhook is still in flight.
      if (gift.refund_requested_at) continue;

      await submitGiftRefund(gift, giftRepo, paymentRepo);
      result.refunded += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({
        message: "gift_expiry_sweep_item_failed",
        gift_id: gift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

/** Boot wiring: run immediately, then on the given interval (default 24h). */
export function startGiftExpirySweep(intervalMs = 24 * 60 * 60 * 1000): void {
  void runGiftExpirySweep(sharedGiftRepo, sharedPaymentRepo);
  timer = setInterval(() => {
    void runGiftExpirySweep(sharedGiftRepo, sharedPaymentRepo);
  }, intervalMs);
  timer.unref();
}

export function stopGiftExpirySweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
