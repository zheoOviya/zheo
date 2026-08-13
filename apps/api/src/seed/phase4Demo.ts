import { sharedChainRepo, sharedIdentityRepo } from "../repositories/shared";

// ============================================
// Phase 4 demo seed (dev server only, never in tests)
// Creates the Chain Owner identity and the "SnakZap Mumbai Chain" with the
// two seeded outlets (Biryani House + Green Bowl) so the vendor /chain and
// /catering pages work out of the box via the demo OTP login.
// ============================================

const CHAIN_OWNER_PHONE = "+919876000001";
const CHAIN_OWNER_ID = "00000000-0000-4000-8000-0000000000c1";
const CHAIN_ID = "c0000000-0000-4000-8000-000000000001";
const BIRYANI_HOUSE = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL = "a0000000-0000-4000-8000-000000000002";

// Admin console demo accounts. TOTP is intentionally OFF so the OTP login
// lands directly on the dashboard; the Security page enables 2FA live.
const ADMIN_PHONE = "+919876000000";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a1";
const SUPER_ADMIN_PHONE = "+919876000099";
const SUPER_ADMIN_ID = "00000000-0000-4000-8000-0000000000a2";

export function seedPhase4DemoData(): void {
  // Dev/demo only: never seed in test or production.
  const env = process.env.NODE_ENV;
  if (env === "test" || env === "production") return;
  if (process.env.SEED_DEMO_DATA === "false") return;

  sharedIdentityRepo._seed({
    id: CHAIN_OWNER_ID,
    phone: CHAIN_OWNER_PHONE,
    role: "VENDOR_OWNER",
    totp_enabled: false,
    created_at: new Date().toISOString(),
  });

  sharedIdentityRepo._seed({
    id: ADMIN_ID,
    phone: ADMIN_PHONE,
    role: "ADMIN",
    totp_enabled: false,
    created_at: new Date().toISOString(),
  });

  sharedIdentityRepo._seed({
    id: SUPER_ADMIN_ID,
    phone: SUPER_ADMIN_PHONE,
    role: "SUPER_ADMIN",
    totp_enabled: false,
    created_at: new Date().toISOString(),
  });

  sharedChainRepo._seed(
    {
      id: CHAIN_ID,
      name: "SnakZap Mumbai Chain",
      owner_id: CHAIN_OWNER_ID,
      created_at: new Date().toISOString(),
    },
    [BIRYANI_HOUSE, GREEN_BOWL],
  );
}
