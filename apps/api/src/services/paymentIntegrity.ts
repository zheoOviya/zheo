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
 * Resolves the local entity total a captured payment must agree with: the gift
 * price for a gift payment, otherwise the order total. A payment bound to
 * neither (or whose entity is missing) yields null, which the PAY4 predicate
 * treats as a violation (fail closed).
 */
async function resolveEntityTotal(
  payment: PaymentDTO,
  lookup: CaptureIntegrityLookup,
): Promise<number | null | undefined> {
  if (payment.gift_id) {
    const gift = lookup.giftRepo ? await lookup.giftRepo.getById(payment.gift_id) : null;
    return gift ? gift.price_paid : null;
  }
  if (payment.order_id) {
    const order = lookup.orderRepo ? await lookup.orderRepo.getById(payment.order_id) : null;
    return order ? order.total_amount : null;
  }
  return null;
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
  return (
    evaluateCaptureIntegrity({
      paymentAmount: payment.amount,
      gatewayCurrency: gateway.currency,
      gatewayAmount: gateway.amount,
      entityTotal: await resolveEntityTotal(payment, lookup),
    }) !== null
  );
}

/**
 * Narrow gateway-truth shape needed to revalidate a locally-CAPTURED payment
 * against the provider before PAY1 recovery. Structurally satisfied by
 * `RazorpayPaymentEntity`.
 */
export interface GatewayCaptureEntity {
  id: string;
  order_id: string;
  currency: string;
  amount: number | null | undefined;
  captured: boolean;
  status: string;
}

/**
 * Why a locally-CAPTURED payment is not safe to recover/refund from gateway
 * truth. Every value is fail-closed: a non-null result forbids any recovery.
 */
export type CapturedRecoveryViolation =
  | "GATEWAY_ENTITY_MISSING"
  | "GATEWAY_PAYMENT_ID_MISMATCH"
  | "GATEWAY_NOT_CAPTURED"
  | "GATEWAY_ORDER_BINDING_MISMATCH"
  | CaptureIntegrityReason;

/**
 * PAY1 (Option C) gateway revalidation for a locally-CAPTURED payment. Proven
 * facts required before an order may be recovered to CONFIRMED, or a captured
 * payment refunded:
 *   - the gateway payment exists and its id matches the local binding
 *   - the gateway reports it as captured
 *   - the gateway order id matches the local razorpay_order_id
 *   - the full PAY4 amount/currency/entity-total predicate passes
 *
 * Returns the first violation, or null when every fact is proven. This is the
 * single definition shared by reconciliation and the operator manual-review
 * surface so the two paths cannot drift.
 */
export async function validateCapturedAgainstGateway(
  payment: PaymentDTO,
  entity: GatewayCaptureEntity | null,
  lookup: CaptureIntegrityLookup,
): Promise<CapturedRecoveryViolation | null> {
  if (!entity) return "GATEWAY_ENTITY_MISSING";
  if (entity.id !== payment.razorpay_payment_id) return "GATEWAY_PAYMENT_ID_MISMATCH";
  if (!(entity.captured || entity.status === "captured")) return "GATEWAY_NOT_CAPTURED";
  if (entity.order_id !== payment.razorpay_order_id) return "GATEWAY_ORDER_BINDING_MISMATCH";
  return evaluateCaptureIntegrity({
    paymentAmount: payment.amount,
    gatewayCurrency: entity.currency,
    gatewayAmount: entity.amount,
    entityTotal: await resolveEntityTotal(payment, lookup),
  });
}
