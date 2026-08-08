// KDS pickup-OTP helpers (apps/vendor).
// Pure functions so the gating rules and error messaging are unit-testable
// without a DOM. The KDS displays the customer's pickup code to staff, who
// type it in; the Hand Over button is only enabled for a complete 4-digit
// code, and failures (invalid/expired code, already picked up, not ready)
// map to human-friendly messages in the UI.

export const PICKUP_OTP_LENGTH = 4;

/** Strips non-digits and caps the input at the 4-digit pickup code length. */
export function sanitizePickupOtp(value: string): string {
  return value.replace(/\D/g, "").slice(0, PICKUP_OTP_LENGTH);
}

/** True when the entered code is a complete 4-digit pickup code. */
export function isPickupOtpComplete(value: string | undefined): boolean {
  return (value ?? "").length === PICKUP_OTP_LENGTH;
}

/**
 * Maps a server error code from POST /orders/:id/confirm-pickup to a
 * human-friendly message shown on the order card. Unknown codes fall back to
 * the server message, or a generic message when nothing is available.
 */
export function pickupFailureMessage(
  code: string | undefined,
  fallback?: string,
): string {
  switch (code) {
    case "INVALID_OTP":
      return "Invalid or expired pickup OTP. Check the code and try again.";
    case "ALREADY_PICKED_UP":
      return "This order was already handed over.";
    case "NOT_READY":
      return "This order is not ready for pickup yet.";
    default:
      return fallback ?? "Could not hand over the order. Please try again.";
  }
}
