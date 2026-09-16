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
 * their expires_at become EXPIRED via an atomic CAS (row must still be due,
 * unbound, and in a fresh-expiry state at write time). Paid gifts (payment
 * CAPTURED, not yet REFUNDED) move to REFUNDING and a Razorpay refund is
 * submitted exactly once (guarded by gifts.refund_requested_at). The gift only
 * reaches REFUNDED when the refund webhook confirms — except in mock/preview
 * mode, where it resolves immediately. Failed refund submissions keep no
 * marker and are retried on the next sweep.
 */
export async function runGiftExpirySweep(
  giftRepo: GiftRepository,
  paymentRepo: PaymentRepository,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, refunded: 0, failed: 0 };
  const due = await giftRepo.listDueForExpiry(now.toISOString());
  const nowIso = now.toISOString();

  for (const gift of due) {
    try {
      // Expiry is a write-time CAS, not a read-time decision: only a gift that
      // is STILL due, unbound, and in a fresh-expiry state at the moment of the
      // write becomes EXPIRED. A gift bound between listDueForExpiry() and this
      // call therefore survives — no EXPIRED write, no GiftExpired event, no
      // refund from the stale DTO.
      let expired: GiftDTO | null = null;
      if (gift.status === "PENDING" || gift.status === "ACTIVE" || gift.status === "CLAIMED") {
        expired = await giftRepo.expireIfDueAndUnbound(gift.id, nowIso);
        if (expired) {
          result.expired += 1;
          await emit(
            createEventEnvelope("GiftExpired", gift.id, { gift_id: gift.id }),
          );
        }
      }

      const payment = await paymentRepo.getByGiftId(gift.id);
      if (!payment) continue;
      // Only a captured payment can be refunded. FAILED payments carry a
      // razorpay_payment_id but were never charged, so refunding one would
      // invent money in mock mode and 400-loop in production.
      if (payment.status !== "CAPTURED") continue;

      const current = expired ?? gift;
      // A refund was already submitted (or is being resolved); skip so we
      // never double-refund a gift whose webhook is still in flight.
      if (current.refund_requested_at) continue;

      // The refund reservation is a CAS constrained to states that were
      // actually expired (or already refunding). If expiry above lost, the
      // gift is e.g. CLAIMED and this CAS loses too: no REFUNDING, no gateway
      // call, no counter inflation.
      const refunded = await submitGiftRefund(current, giftRepo, paymentRepo, [
        "EXPIRED",
        "REFUNDING",
      ]);
      if (refunded.status === "REFUNDING" || refunded.status === "REFUNDED") {
        result.refunded += 1;
      }
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
