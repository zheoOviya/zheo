# SnakZap

**Pickup-first food ordering — order ahead, skip the wait.**

SnakZap is a full-stack, pickup-only food ordering platform for the Indian
market. Consumers order ahead from nearby restaurants, pay digitally, and
pick up without waiting; vendors run a live kitchen dashboard with OTP/QR
handover, settlements, and B2B tools; operations gets real-time discovery,
wearable integration, and VIP support routing.

The entire platform (Phases 1-4) is built in this single monorepo and
certified **GO** against the ZHEO v3 EOS governance framework.

## Highlights

- **4 production apps** in one Turborepo: consumer (Next.js), vendor
  (Next.js), admin ops console (Next.js), and an Express API.
- **7 strictly separated bounded contexts** — identity, catalog, ordering,
  payments, fulfillment, loyalty, vendor ops — that only collaborate through
  injected repositories and an async event bus.
- **25-event typed event catalog** (EOS Layer 1.2) with zod-validated
  envelopes and acyclic dependencies.
- **RBAC-gated chain & B2B surfaces** (`VENDOR_OWNER` / `ADMIN`) with
  ownership guards.
- **292 automated tests** across 36 files + 5/5 package typecheck green.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15, React 19, Tailwind CSS, Zustand |
| API | Express 4, TypeScript, Zod, tsx |
| Data | Drizzle ORM (Postgres schema + migrations), Redis (ioredis) |
| Eventing | In-process async event bus (typed EOS envelopes) |
| Payments/POS | Razorpay + Petpooja integrations (mock seams in dev) |
| Tooling | pnpm, Turborepo, Vitest |

## Repository Layout

```
apps/
  api/         Express API server (port 3001) - routes, services, repositories
  consumer/    Consumer ordering app (port 3000)
  vendor/      Vendor kitchen + B2B dashboard (port 3002)
  admin/       Ops console - live order heatmap (port 3003)
packages/
  config/      Shared Tailwind preset (teal palette + skeleton animation)
  db/          Drizzle schema + SQL migrations (0000..0006)
  types/       Domain types, event catalog, envelope contracts
  ui/          Shared UI components
work-logs/     Per-phase feature work-logs, audits, and certification manifests
```

## Features

### Phase 1 - MVP
Catalog & discovery, OTP auth with JWT refresh rotation + device
fingerprinting, ordering with customizations, simulated Razorpay payments,
strict fulfillment state machine with OTP/QR pickup, vendor kitchen dashboard,
settlements, menu management with photo upload.

### Phase 2 - Vendor & Loyalty
Petpooja POS webhook + menu sync (idempotent), GST/insights aggregation, GST
CSV export, promotions, atomic bulk menu edit, Refer & Earn, stamp cards, and
traffic-based ETA with early-ready alerts.

### Phase 3 - User Growth
Personalized homepage (cold-start rules + anti-filter-bubble), trending now,
group orders (race-safe per-token mutex), 100 m geo-fence auto check-in,
SnakZap wallet + 1% cashback, spice tolerance profile, pickup streak badges,
24 h cart persistence.

### Phase 4 - Multi-City & B2B Scale
Catering orders (50+ headcount, bulk pricing, segregated flow), multi-outlet
chains with strict RBAC + ownership guards, 30-minute hyperlocal heatmap,
smart-watch app with < 500-byte payloads, VIP customer support with automatic
HIGH-priority routing to a specialized ops agent.

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm >= 9

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example apps/api/.env   # edit secrets as needed

# 3. Start everything (API + all three apps)
pnpm dev
```

The API runs from in-memory repositories out of the box (seeded with demo
restaurants), so no Postgres/Redis instance is required to run or test.

### Service Ports

| Service | URL | Command |
|---|---|---|
| Consumer | http://localhost:3000 | `pnpm --filter @snakzap/consumer dev` |
| API | http://localhost:3001 | `pnpm --filter @snakzap/api dev` |
| Vendor | http://localhost:3002 | `pnpm --filter @snakzap/vendor dev` |
| Admin | http://localhost:3003 | `pnpm --filter @snakzap/admin dev` |

Frontends proxy `/api/*` to the API server, so one exposed port per app serves
the full stack.

### Demo Access

- **Consumer OTP login**: any 6-digit OTP is accepted outside production
  (e.g. `111111`).
- **Vendor chain demo**: the vendor app silently logs in as the seeded Chain
  Owner (`+919876000001`, OTP `111111`) to reach the RBAC-gated chain and
  catering endpoints.
- **Payments/POS**: `valid_sig_*` signature prefixes simulate successful
  webhooks in dev; real HMAC verification activates when secrets are set.

## Verification

```bash
pnpm vitest run     # full test suite (292 tests / 36 files)
pnpm typecheck      # turbo typecheck, 5/5 packages
```

Per-phase audits and the final project certification live in `work-logs/`:

- `work-logs/phase-*/PHASE_*_AUDIT_REPORT.md` — ECS certification matrices
- `work-logs/GRAND_PROJECT_CERTIFICATION.json` — overall project verdict (GO)

## Architecture Notes

### Bounded Contexts

Each context owns its route module, service layer, and repository. Contexts
never read each other's tables or call each other's services directly —
collaboration happens via **dependency-injected repositories** (anti-corruption
layer) and the **event bus**.

| Context | Primary surface |
|---|---|
| Identity | OTP/JWT auth, user profile, spice tolerance |
| Catalog | Restaurants, menus, discovery, search, heatmap |
| Ordering | Orders, cart, group orders, catering |
| Payments | Razorpay orders + webhooks |
| Fulfillment | State machine, geo-fence, wear API |
| Loyalty | Referral, wallet, streaks, stamp cards, VIP support |
| Vendor Ops | POS, settlements, GST, insights, chains |

### Event Catalog (25 events)

`OrderCreated, PaymentSucceeded, PaymentFailed, OrderPreparationStarted,
OrderReadyForPickup, OrderPickedUp, OTPGenerated, SettlementCalculated,
PosOrderImported, PosMenuSynced, ReferralClaimed, StampCardRewardUnlocked,
EarlyReadyAlert, PersonalizedHomepageViewed, TrendingQueried,
GroupOrderCreated, GroupOrderItemAdded, UserArrivedAtRestaurant,
WalletCashbackCredited, StreakBadgeUnlocked, SpiceProfileUpdated,
CateringOrderCreated, HeatmapQueried, WearOrderListed, VipTicketCreated`

### Security Baseline

`.gitignore` excludes `node_modules/`, all `.env*`, build outputs (`.next/`,
`dist/`, `out/`, `.turbo/`), logs, and TypeScript build info. No secrets or
credentials are committed; configuration is read exclusively from the
environment.

## License

Private repository. All rights reserved.
