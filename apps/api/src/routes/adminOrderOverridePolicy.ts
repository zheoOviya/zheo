import type { OrderStatus } from "@snakzap/types";

// ============================================
// Admin order status override policy (ADMIN-ORDER-OVERRIDE-A2)
//
// Pure, side-effect-free decision layer for the SUPER_ADMIN override route.
// The route owns auth, reads, the single CAS write and audit; this module only
// answers "may this transition happen?" so the rules are unit-testable without
// an Express app or a database.
//
// FROZEN CONTRACT:
//  - Default path allows only normal operational transitions.
//  - Explicit force (SUPER_ADMIN + reason) may leave the normal state machine
//    but can never touch payment-coupled states or regress a terminal state.
//  - SETTLED was removed from the target set; payment statuses are never
//    targetable, even with force.
// ============================================

/** The ONLY statuses an admin override may write. SETTLED is deliberately absent. */
export const ADMIN_OVERRIDE_TARGET_STATUSES = [
  "CONFIRMED",
  "PREPARING",
  "ALMOST_READY",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "CANCELLED",
] as const;

export type AdminOverrideTargetStatus =
  (typeof ADMIN_OVERRIDE_TARGET_STATUSES)[number];

/**
 * Payment / settlement owned states. Never a valid target and never a valid
 * source, even under force — these belong to the D-PAY/payment boundary.
 */
export const PAYMENT_COUPLED_STATUSES: readonly OrderStatus[] = [
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "REFUNDED",
  "SETTLED",
  "DISPUTED",
  "EXPIRED",
];

/** Terminal states that must never be regressed, even with force. */
export const NON_REGRESSABLE_STATUSES: readonly OrderStatus[] = [
  "PICKED_UP",
  "CANCELLED",
  "SETTLED",
  "REFUNDED",
  "PAYMENT_FAILED",
  "DISPUTED",
  "EXPIRED",
];

/** Normal forward operational transitions permitted without force. */
const DEFAULT_TRANSITIONS: Partial<Record<OrderStatus, readonly OrderStatus[]>> = {
  CONFIRMED: ["PREPARING"],
  PREPARING: ["ALMOST_READY"],
  ALMOST_READY: ["READY_FOR_PICKUP"],
  READY_FOR_PICKUP: ["PICKED_UP"],
};

/**
 * Existing cancellable non-payment states (mirrors fulfillment.cancelOrder,
 * minus PAYMENT_PENDING which is payment-coupled and therefore held).
 */
const DEFAULT_CANCELLABLE_FROM: readonly OrderStatus[] = [
  "DRAFT",
  "CONFIRMED",
  "PREPARING",
];

export type OverridePolicyRejection =
  | "PAYMENT_COUPLED_TARGET"
  | "PAYMENT_COUPLED_SOURCE"
  | "TERMINAL_REGRESSION"
  | "DEFAULT_TRANSITION_NOT_ALLOWED";

export interface OverridePolicyInput {
  from: OrderStatus;
  to: OrderStatus;
  force: boolean;
}

export function isPaymentCoupledStatus(status: OrderStatus): boolean {
  return PAYMENT_COUPLED_STATUSES.includes(status);
}

export function isNonRegressableStatus(status: OrderStatus): boolean {
  return NON_REGRESSABLE_STATUSES.includes(status);
}

export function isAllowedOverrideTarget(
  status: string,
): status is AdminOverrideTargetStatus {
  return (ADMIN_OVERRIDE_TARGET_STATUSES as readonly string[]).includes(status);
}

/**
 * Returns `null` when the override is permitted, otherwise a deterministic
 * machine-readable rejection reason. Callers map every rejection to a 4xx.
 */
export function evaluateOverridePolicy(
  input: OverridePolicyInput,
): OverridePolicyRejection | null {
  const { from, to, force } = input;

  if (isPaymentCoupledStatus(to)) return "PAYMENT_COUPLED_TARGET";
  if (isPaymentCoupledStatus(from)) return "PAYMENT_COUPLED_SOURCE";

  if (force) {
    if (isNonRegressableStatus(from)) return "TERMINAL_REGRESSION";
    return null;
  }

  const allowed = DEFAULT_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return null;
  if (to === "CANCELLED" && DEFAULT_CANCELLABLE_FROM.includes(from)) return null;

  return "DEFAULT_TRANSITION_NOT_ALLOWED";
}
