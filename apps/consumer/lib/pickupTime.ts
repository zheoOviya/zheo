// ============================================
// Pickup-slot time helpers (consumer)
// ============================================

/** Fixed IST offset from UTC: UTC+05:30 (India has no DST). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * IST calendar date (YYYY-MM-DD) for an instant.
 *
 * The pickup-slots API treats its `date` parameter as an IST calendar day, so
 * the browser must derive the date in IST rather than UTC. Between 00:00 and
 * 05:30 IST the UTC date still lags by one day; sending it would make the API
 * see a past date and return no slots.
 */
export function istDateString(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
