// Shared constants for the E2E suite. Keep these in sync with:
//   - each app's `dev` script (ports)
//   - apps/api/src/routes/catalog.ts SEED_RESTAURANTS (restaurant id)
//   - apps/api/src/seed/phase4Demo.ts (seeded demo identities)

export const CONSUMER_URL = "http://localhost:3000";
export const VENDOR_URL = "http://localhost:3002";
export const ADMIN_URL = "http://localhost:3003";
export const API_URL = "http://localhost:3001";

// Seeded demo identities (TOTP off, so OTP lands directly on the console).
export const SEEDED_VENDOR_PHONE = "+919876000001";
export const SEEDED_ADMIN_EMAIL = "admin@snakzap.dev";
export const SEEDED_ADMIN_PHONE = "+919876000000";

// Biryani House is the outlet bound to RESTAURANT_ID in the vendor console,
// so a consumer order here is visible to the seeded vendor in the same API
// process.
export const BIRYANI_HOUSE_ID = "a0000000-0000-4000-8000-000000000001";

// Generates a unique 10-digit Indian mobile number per run so tests never
// collide with a previously suspended consumer across repeated runs.
export function uniquePhone(): string {
  return `9${String(Date.now()).slice(-9)}`;
}
