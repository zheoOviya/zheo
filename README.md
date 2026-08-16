# SnakZap

**Pickup-First Food Ordering Platform**

[![Tests](https://img.shields.io/badge/tests-386-brightgreen)](https://github.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-black)](https://nextjs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.15-orange)](https://pnpm.io/)
[![WCAG](https://img.shields.io/badge/WCAG-2.1_AA-003366)](https://www.w3.org/WAI/standards-guidelines/wcag/)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8)](apps/consumer/public/sw.js)

> **North Star Metric:** "Time from order to first bite."
> **Design Constraint:** No delivery. Maximum 10% commission.

SnakZap is a pickup-only food ordering platform for the Indian market. Consumers order ahead, pay digitally, and pick up without waiting. Vendors run live kitchens with OTP/QR handover, daily settlements, and B2B chain management. Operations gets an admin console with RBAC, kill switches, and audit trails.

This is a **startup-grade / portfolio monorepo** built as a demonstration of full-stack TypeScript architecture with domain-driven design. It is not a Fortune 500 production system. In-memory repositories stand in for PostgreSQL in development; Redis is used for caching, session storage, and the event bus.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15.5 (App Router, RSC), React 19, Tailwind CSS (Teal `#0D9488`), Zustand |
| API | Express 4, TypeScript, Zod, tsx |
| ORM | Drizzle ORM (PostgreSQL schema + migrations) |
| Cache | Redis (ioredis) -- sessions, cart persistence, rate limiting, catalog cache |
| Events | Redis Pub/Sub (`snakzap:events` channel) with in-process fallback |
| Payments | Razorpay integration (mock seam in dev) |
| POS | Petpooja integration (mock seam in dev) |
| Testing | Vitest, Supertest -- 386 tests across 45 files |
| Tooling | pnpm 9.15, Turborepo 2.3, TypeScript 5.7 |

## Repository Layout

```
snakzap/
├── apps/
│   ├── api/              Express API server (:3001)
│   ├── consumer/         Consumer ordering app (:3000) -- Next.js 15 RSC
│   ├── vendor/           Vendor kitchen + B2B dashboard (:3002)
│   └── admin/            Ops console (:3003) -- governance, RBAC, audit oversight
├── packages/
│   ├── config/           Shared Tailwind preset
│   ├── db/               Drizzle ORM schema + SQL migrations
│   ├── types/            Domain types, event catalog contracts
│   └── ui/               Shared React components
├── work-logs/            Per-phase feature logs and audit reports
├── turbo.json            Turborepo task pipeline
└── vitest.config.ts
```

## Domain-Driven Design

Seven bounded contexts, each owning its routes, services, and repositories. Cross-context communication is via injected repositories and the Redis Pub/Sub event bus.

| Context | Responsibility |
|---------|---------------|
| Identity | OTP/JWT auth, user profiles, role management |
| Catalog | Restaurants, menus, dietary filters, discovery, heatmap |
| Ordering | Orders, cart persistence, group orders, catering |
| Payments | Razorpay order creation + webhook handling |
| Fulfillment | State machine, geo-fence, OTP/QR pickup, wear API |
| Loyalty | Referrals, wallet cashback, streak badges, stamp cards, VIP support |
| Vendor Ops | POS integration, settlements, GST, insights, chains, menu management |

### Event Catalog (25 typed domain events)

```
OrderCreated, PaymentSucceeded, PaymentFailed, OrderPreparationStarted,
OrderReadyForPickup, OrderPickedUp, OTPGenerated, SettlementCalculated,
PosOrderImported, PosMenuSynced, ReferralClaimed, StampCardRewardUnlocked,
EarlyReadyAlert, PersonalizedHomepageViewed, TrendingQueried,
GroupOrderCreated, GroupOrderItemAdded, UserArrivedAtRestaurant,
WalletCashbackCredited, StreakBadgeUnlocked, SpiceProfileUpdated,
CateringOrderCreated, HeatmapQueried, WearOrderListed, VipTicketCreated
```

Events are published to Redis Pub/Sub (`snakzap:events` channel) for cross-instance distribution, with in-process dispatch running first for same-process performance. Falls back to in-process-only when Redis is unavailable.

## Features

### Phase 1 -- MVP (9 features)
OTP auth with JWT refresh rotation, restaurant catalog with search and dietary filters, order placement with Razorpay webhook idempotency, fulfillment state machine (CONFIRMED to PICKED_UP), OTP + QR code pickup verification, WebSocket real-time order tracking, vendor daily settlements (tiered commission 0%/8%), vendor menu photo upload, consumer + vendor apps.

### Phase 2 -- Vendor & Loyalty (5 features)
Petpooja POS webhook (HMAC-SHA256 + idempotency), customer insights dashboard (AOV, repeat rate, peak hours), stable phone-keyed identity, referral system with fraud screening, stamp card loyalty.

### Phase 3 -- User Growth (8 features)
Personalized homepage (rule-based + anti-filter-bubble), Trending Now (geo-radius), group orders (race-safe mutex, masked contributors), 100m geo-fence auto check-in, SnakZap Wallet (1% cashback, double-entry ledger), spice tolerance profile (auto-filters menu), 7-day pickup streak badges, 24h cart persistence.

### Phase 4 -- Scale (5 features)
Catering/B2B orders (segregated flow), multi-outlet chains (ownership guards, aggregate insights), 30-minute hyperlocal heatmap, smart-watch API (<500 byte payloads, one-tap reorder), VIP customer support (auto-prioritization + OPS_AGENT assignment).

### UX Sprints (5 sprints)
Next.js middleware auth, checkout page, skeleton loading states, dual-enforced cart expiry, PWA (service worker + manifest), dark mode, WCAG 2.1 AA accessibility, i18n (en/hi, 271 keys), A/B testing feature flags.

### Admin Governance (11 features)
Edge middleware (JWT cookie check), OTP admin login, sidebar navigation. Kill switches (DB-persisted, toggle UI), vendor lifecycle (suspend/reactivate with audit trail), audit log viewer (paginated, filterable), live orders dashboard (30s auto-refresh, detail expand, SUPER_ADMIN override), user management (search, suspend/reactivate, role promotion), support ticket oversight (assignee dropdown, status workflow), vendor route RBAC, metrics dashboard (CAC/LTV, sparkline trends, 60s auto-refresh). 19 RBAC-gated admin endpoints with `adminReadOnly` (ADMIN + SUPER_ADMIN + OPS_AGENT) vs `adminWrite` (ADMIN + SUPER_ADMIN only). Rate limiter fail-closed on auth, payments, and admin write endpoints (503 when Redis is down).

## Security Model

- **Consumer:** JWT refresh rotation + jti replay detection + device fingerprinting
- **Vendor:** RBAC middleware on all routes (`VENDOR_OWNER`, `VENDOR_STAFF`, `ADMIN`, `SUPER_ADMIN`)
- **Admin:** Edge middleware (JWT cookie check) + `adminReadOnly`/`adminWrite` + SUPER_ADMIN gating on destructive operations
- **Webhooks:** HMAC signature verification (Razorpay, Petpooja) + idempotency dedup
- **Rate Limiting:** Redis sliding window -- fail-open for general API (100/min), fail-closed for auth/OTP/payments/admin-write (503 on Redis failure)
- **Audit Trail:** All admin mutations logged to `audit_logs` (actor_id, action, metadata)

## Getting Started

### Prerequisites
- Node.js >= 20
- pnpm >= 9
- PostgreSQL and Redis are optional for development (in-memory repositories seeded with demo data)

### Quick Start

```bash
pnpm install
cp .env.example apps/api/.env
pnpm dev
```

### Service Ports

| Service | URL | Command |
|---------|-----|---------|
| Consumer | `http://localhost:3000` | `pnpm --filter @snakzap/consumer dev` |
| API | `http://localhost:3001` | `pnpm --filter @snakzap/api dev` |
| Vendor | `http://localhost:3002` | `pnpm --filter @snakzap/vendor dev` |
| Admin | `http://localhost:3003` | `pnpm --filter @snakzap/admin dev` |

### Demo Access

- Consumer OTP login: any 6-digit OTP is accepted in dev (e.g. `111111`)
- Vendor demo: `+919876000001`, OTP `111111`
- Admin demo: `+919876000003`, OTP `111111` (SUPER_ADMIN)
- Payment/POS webhooks: `valid_sig_` prefix simulates HMAC in dev

See [docs/vendor-restaurant-resolution.md](docs/vendor-restaurant-resolution.md)
for how the vendor console resolves multi-restaurant access and API/WebSocket
origins.

### Verification

```bash
pnpm vitest run    # 386 tests / 45 files
pnpm typecheck      # Turbo typecheck all packages
```

## Known Limitations

- In-memory repositories are the default development mode. PostgreSQL is available via `DATABASE_URL` env var but requires Drizzle migrations to be applied first.
- The event bus uses Redis Pub/Sub (at-least-once delivery, no persistence). For production use, consider upgrading to Redis Streams or Kafka for durability guarantees.
- Watch API and geo-fence coordinates are mocked in development. Real location services require integration.
- Payment and POS webhooks use mock signature verification in dev. Real HMAC activates when secrets are configured.

## License

[MIT](LICENSE)
