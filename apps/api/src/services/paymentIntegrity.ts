import type { PaymentDTO } from "../repositories/paymentRepository";
import type { OrderRepository } from "../repositories/orderRepository";
import type { GiftRepository } from "../repositories/giftRepository";

// ============================================
// RISK-PAY-4 amount/currency integrity (shared)
//
// The capture predicate below is the frozen PAY-4 rule. Webhook processing
// (PaymentService) and the reconciliation engine (PAY3-B) must both evaluate
// the exact same predicate; this module is the single definition so an edge
// case or a later fix cannot drift between the two code paths.
// ============================================

/** Only Indian Rupee captures are accepted (Indian-market product). */
export const PAY4_CURRENCY = "INR";

export type CaptureIntegrityReason =
  | "WRONG_CURRENCY"
  | "GATEWAY_AMOUNT_MISMATCH"
  | "ENTITY_MISSING"
  | "ENTITY_AMOUNT_MISMATCH";

export interface CaptureIntegrityInput {
  /** Local payment amount in major units (rupees). */
  paymentAmount: number;
  /** Gateway-reported currency (e.g. "INR"). */
  gatewayCurrency: string;
  /** Gateway-reported amount in the smallest unit (paise). */
  gatewayAmount: number | null | undefined;
  /** Order total / gift price in major units; null when the entity is missing. */
  entityTotal: number | null | undefined;
}

/**
 * The frozen PAY-4 capture predicate. Returns the violation reason, or null
 * when the capture is valid:
 *   currency === "INR"
 *   gateway amount === round(payment.amount * 100)
 *   AND entity total === round(payment.amount * 100)
 */
export function evaluateCaptureIntegrity(
  input: CaptureIntegrityInput,
): CaptureIntegrityReason | null {
  const expectedPaise = Math.round(input.paymentAmount * 100);
  if (input.gatewayCurrency !== PAY4_CURRENCY) return "WRONG_CURRENCY";
  if (typeof input.gatewayAmount !== "number" || input.gatewayAmount !== expectedPaise) {
    return "GATEWAY_AMOUNT_MISMATCH";
  }
  if (input.entityTotal === null || input.entityTotal === undefined) {
    return "ENTITY_MISSING";
  }
  if (Math.round(input.entityTotal * 100) !== expectedPaise) {
    return "ENTITY_AMOUNT_MISMATCH";
  }
  return null;
}

export interface CaptureIntegrityLookup {
  orderRepo?: Pick<OrderRepository, "getById">;
  giftRepo?: Pick<GiftRepository, "getById">;
}

/**
 * True when a captured gateway payment must be quarantined instead of
 * fulfilled. A gift payment is checked against the gift price; an order
 * payment against the order total. A payment bound to neither (or whose
 * entity is missing) is always quarantined — the same fail-closed behaviour
 * the webhook path always had.
 */
export async function isCaptureQuarantined(
  payment: PaymentDTO,
  gateway: { currency: string; amount: number | null | undefined },
  lookup: CaptureIntegrityLookup,
): Promise<boolean> {
  let entityTotal: number | null | undefined = null;
  if (payment.gift_id) {
    const gift = lookup.giftRepo ? await lookup.giftRepo.getById(payment.gift_id) : null;
    entityTotal = gift ? gift.price_paid : null;
  } else if (payment.order_id) {
    const order = lookup.orderRepo ? await lookup.orderRepo.getById(payment.order_id) : null;
    entityTotal = order ? order.total_amount : null;
  }
  return (
    evaluateCaptureIntegrity({
      paymentAmount: payment.amount,
      gatewayCurrency: gateway.currency,
      gatewayAmount: gateway.amount,
      entityTotal,
    }) !== null
  );
}
