# End-to-End Tests (Playwright)

Role-based multi-agent E2E coverage for the SnakZap platform. One Playwright
config drives three console projects (consumer, vendor, admin) plus a
cross-agent project that walks a single order through all three consoles.

## Layout

```
playwright.config.ts          # projects + webServer bootstrapping
e2e/
  helpers/
    constants.ts              # ports, seeded identities, restaurant id, uniquePhone()
    consumer.ts               # consumerLogin / consumerSignOut / addBiryaniToCart
    vendor.ts                 # vendorLogin
    admin.ts                  # adminLogin
  consumer/                   # auth, mobile drawer, profile, ordering
  vendor/                     # auth, orders
  admin/                      # auth, users
  cross-agent/                # consumer -> vendor -> admin -> consumer lifecycle
```

## Prerequisites

1. Install the runner and browsers (one time):

   ```bash
   pnpm install
   pnpm exec playwright install --with-deps chromium
   ```

2. A running stack. `playwright.config.ts` boots the four dev servers
   automatically (API `:3001`, consumer `:3000`, vendor `:3002`, admin
   `:3003`) and reuses them when already up locally (`reuseExistingServer`).

   - The API must serve a healthy `/health` (200). In local dev it falls back to
     in-memory repositories when Postgres is unreachable; Redis must be up for a
     200 (or run with a full Postgres+Redis stack).
   - Demo seed data is on by default (`SEED_DEMO_DATA` is not `"false"`), which
     provides the vendor chain owner and admin accounts used by the specs.

## Running

```bash
# Whole suite (all four projects)
pnpm test:e2e

# A single project
pnpm exec playwright test --project consumer
pnpm exec playwright test --project cross-agent

# Interactive watch UI
pnpm test:e2e:ui
```

## Design notes

- **Single worker.** The three consoles share one API process whose OTP store is
  keyed by phone, so parallel logins for the same seeded account would race.
  Run against isolated database-backed stacks before raising `workers`.
- **Unique consumers.** `uniquePhone()` mints a fresh 10-digit number per run so
  consumer tests never collide with a previously suspended account.
- **Demo OTP.** Consumer and admin auto-fill the OTP in preview mode; the vendor
  console prints "Demo code: XXXXXX" instead, so `vendorLogin` reads it from the
  DOM.
- **Cross-agent order visibility.** The consumer orders from Biryani House
  (`a0000000-0000-4000-8000-000000000001`), which is the outlet bound to the
  vendor console's `RESTAURANT_ID`, so the order appears in the vendor list.

## Adding a test

Add the spec under the matching `e2e/<role>/` directory. Reuse the helpers
instead of re-encoding login flows, and prefer accessible-name selectors
(`getByRole`) so tests stay resilient to styling changes.
