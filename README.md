# SnakZap

**Pickup-First Food Ordering Platform & Engineering Operating System**

[![ZHEO v3](https://img.shields.io/badge/ZHEO-v3-0D9488)](work-logs/GRAND_PROJECT_V2_CERTIFICATION.json)
[![Tests](https://img.shields.io/badge/tests-386-brightgreen)](https://github.com)
[![Certification](https://img.shields.io/badge/certification-GO-success)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-black)](https://nextjs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.15-orange)](https://pnpm.io/)
[![WCAG](https://img.shields.io/badge/WCAG-2.1_AA-003366)](https://www.w3.org/WAI/standards-guidelines/wcag/)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8)](apps/consumer/public/sw.js)

> **North Star Metric:** _"Time from order to first bite."_  
> **Anti-Vision:** No delivery. Maximum 10% commission. Zero kitchen dependency — the platform is the pickup layer.

SnakZap is a complete monorepo implementing a pickup-only food ordering platform for the Indian market. Consumers order ahead, pay digitally, and pick up without waiting. Vendors run live kitchens with OTP/QR handover, daily settlements, and B2B chain management. Operations gets a full governance console with RBAC, kill switches, audit trails, and VIP support routing. The platform ships with **36 features**, an **25-event typed catalog**, **7 bounded contexts**, and **19 admin governance endpoints** — all certified **GO** under the ZHEO v3 EOS framework.

---

## Table of Contents

- [The ZHEO v3 Philosophy](#the-zheo-v3-philosophy)
- [Monorepo Architecture](#monorepo-architecture)
- [Tech Stack](#tech-stack)
- [Domain-Driven Design](#domain-driven-design)
- [Features Shipped](#features-shipped)
- [Certification & Quality](#certification--quality)
- [Getting Started](#getting-started)
- [Demo Access](#demo-access)
- [Verification](#verification)
- [Architecture Notes](#architecture-notes)

---

## The ZHEO v3 Philosophy

SnakZap is not just a PRD. It is an **Engineering Operating System (EOS)** that enforces architectural integrity at every layer:

| Layer | Name | Role |
|-------|------|------|
| **Layer 0** | Product PRD | What the platform must do — features, personas, acceptance criteria |
| **Layer 1** | EOS (Event-Oriented System) | How the platform communicates — typed event envelopes, acyclic dependency graph, domain event sourcing |
| **Layer 2** | EGS (Engineering Guardrail System) | How the platform is secured — RBAC middleware, audit trail, rate limiting, idempotency, ownership guards |
| **Layer 3** | ECS (Engineering Certification System) | How the platform is proven — automated test suites, typecheck gates, compliance matrices, per-phase audit reports |

> "Zero-Hallucination" enforcement: every feature must ship with an audit-trail implementation, an RBAC placement, and a certification test. Code that passes the design review but fails the certification audit cannot ship.

---

## Monorepo Architecture

```
snakzap/
├── apps/
│   ├── api/              Express API server (:3001) — routes, services, repositories
│   ├── consumer/         Consumer ordering app (:3000) — Next.js 15 RSC
│   ├── vendor/           Vendor kitchen + B2B dashboard (:3002)
│   └── admin/            Ops console (:3003) — governance, RBAC, audit oversight
├── packages/
│   ├── config/           Shared Tailwind preset (teal palette, skeleton animations)
│   ├── db/               Drizzle ORM schema + SQL migrations (0000-0010)
│   ├── types/            Domain types, event catalog, envelope contracts (ZHEO Layer 1.2)
│   └── ui/               Shared React components
├── work-logs/            Per-phase feature logs, audit reports, certification manifests
├── docs/                 ADRs (Architecture Decision Records)
├── turbo.json            Turborepo task pipeline (11 tasks, cached builds)
├── vitest.config.ts      386-test suite configuration
└── pnpm-workspace.yaml
```

> **Unique structure:** The `work-logs/` directory serves as the project's institutional memory — every phase, sprint, audit, and certification decision is version-controlled alongside the code. No external wiki, no external Notion — the repo is the single source of truth.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 15.5 (App Router, RSC), React 19, Tailwind CSS 3 (Teal `#0D9488`), Zustand | Consumer + Vendor + Admin apps |
| **API** | Express 4, TypeScript, Zod, tsx, Winston | REST API with typed request/response envelopes |
| **ORM** | Drizzle ORM | PostgreSQL schema, migrations, query builder |
| **Cache** | Redis (ioredis) | Session tokens, cart persistence, rate limiting, catalog cache, PubSub |
| **Event Bus** | In-process async typed bus | EOS Layer 1.2 — zod-validated domain events with per-handler isolation |
| **Payments** | Razorpay (mock seam in dev) | HMAC-signed webhooks, idempotent payment dedup |
| **POS** | Petpooja (mock seam in dev) | HMAC-signed POS webhooks, order import, menu sync |
| **Testing** | Vitest, Supertest | 386 tests across 45 files |
| **Tooling** | pnpm 9.15, Turborepo 2.3, TypeScript 5.7 | Monorepo orchestration |
| **CI/CD** | GitHub Actions | typecheck, lint, test matrix |
| **A11y** | next/image, skip-to-content, focus trapping, ARIA | WCAG 2.1 AA |
| **PWA** | Service Worker, Web Manifest | Offline caching, installable |
| **i18n** | Custom React context | en/hi, 271 translation keys |

---

## Domain-Driven Design

### 7 Bounded Contexts

Each context owns its route module, service layer, and repository. Contexts **never** read each other's tables or call each other's services directly — collaboration happens exclusively via dependency-injected repositories (anti-corruption layer) and the async event bus.

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Identity │  │  Catalog │  │ Ordering │  │ Payments │
│  Auth    │  │ Menu/Disc│  │ Cart/Grp │  │ Razorpay │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │              │
     └──────────────┼──────────────┼──────────────┘
                    │  Event Bus   │
     ┌──────────────┼──────────────┼──────────────┐
     │              │              │              │
┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐
│Fulfillment│ │ Loyalty  │  │ Vendor   │  │  Admin   │
│State Mach │ │Wallet/Stm│  │ Ops/POS  │  │Governance│
└───────────┘  └──────────┘  └──────────┘  └──────────┘
```

| Context | Primary Surface | Key Artifacts |
|---------|----------------|---------------|
| **Identity** | OTP/JWT auth, user profile, spice tolerance, role management | `identityRepository.ts`, `middleware/requireRoles.ts` |
| **Catalog** | Restaurants, menus, dietary filters, discovery, search, heatmap | `catalogRepository.ts`, `discoveryService.ts` |
| **Ordering** | Orders, cart persistence, group orders, catering | `orderingService.ts`, `groupOrdersRouter.ts` |
| **Payments** | Razorpay order creation + webhook handling | `paymentRouter.ts`, `razorpayService.ts` |
| **Fulfillment** | State machine, geo-fence, OTP/QR pickup, wear API | `fulfillmentService.ts`, `geoFenceService.ts` |
| **Loyalty** | Referral, wallet cashback, streak badges, stamp cards, VIP support | `loyaltyRouter.ts`, `walletService.ts`, `streakService.ts`, `supportService.ts` |
| **Vendor Ops** | POS integration, daily settlements, GST, insights, chains, menu mgmt | `vendorRouter.ts`, `settlementEngine.ts`, `insightsService.ts` |

### Event Catalog (25 Domain Events)

ZHEO v3 EOS Layer 1.2 — every domain event has a typed envelope `{event_id, event_name, aggregate_id, timestamp, payload, metadata}`, zod-validated payloads, and acyclic dependency graph:

```
OrderCreated              → triggers PaymentSucceeded/Failed, personalized scoring
PaymentSucceeded          → advances order to CONFIRMED
PaymentFailed             → returns order to DRAFT
OrderPreparationStarted   → generates OTP + QR token
OrderReadyForPickup       → enables consumer pickup flow
OrderPickedUp             → triggers WalletCashbackCredited, StampCard, Streak
OTPGenerated              → audit record for pickup verification
SettlementCalculated      → vendor daily settlement computed
PosOrderImported          → Petpooja POS order ingested (idempotent)
PosMenuSynced             → Petpooja menu synchronized to catalog
ReferralClaimed           → referrer wallet credited (post 5-gate fraud screen)
StampCardRewardUnlocked   → 10th stamp → coupon
EarlyReadyAlert           → order ready before scheduled time
PersonalizedHomepageViewed→ cold-start scoring + anti-filter-bubble
TrendingQueried           → geo-radius trending feed
GroupOrderCreated         → shareable group cart minted
GroupOrderItemAdded       → contributor added (race-safe mutex)
UserArrivedAtRestaurant   → geo-fence auto check-in
WalletCashbackCredited    → 1% pickup cashback ledger entry
StreakBadgeUnlocked       → 7-day streak badge + 10% coupon
SpiceProfileUpdated       → menu auto-filtered by tolerance
CateringOrderCreated      → B2B bulk order (segregated flow)
HeatmapQueried            → 30-min live density grid
WearOrderListed           → smart-watch active orders (<500 bytes)
VipTicketCreated          → HIGH-priority support ticket auto-assigned OPS_AGENT
```

---

## Features Shipped

### Phase 1 -- MVP Core Engine (9 features)

Consumer auth (OAuth2 phone + JWT refresh rotation), restaurant catalog (search, dietary filter, menu browsing), order placement with Razorpay webhook idempotency, strict fulfillment state machine, OTP + QR code pickup verification, real-time WebSocket status tracking, vendor daily settlements (tiered commission 0%/8%), vendor menu photo upload + item management, consumer + vendor apps.

### Phase 2 -- Vendor Tools & Loyalty (5 features)

Petpooja POS webhook (HMAC-SHA256 + idempotency on pos_order_id), Customer Insights dashboard (AOV, repeat rate, peak hours chart), stable phone-keyed identity (shared repo across contexts), referral system (5-gate fraud screening), stamp card loyalty.

### Phase 3 -- User Growth & Engagement (8 features)

Personalized homepage (rule-based V1 + anti-filter-bubble surprise), Trending Now (60-min geo-radius), group orders (race-safe per-token mutex, masked contributors), 100 m geo-fence auto check-in, SnakZap Wallet (1% cashback, double-entry ledger), spice tolerance profile (1-5, auto-filters menu), pickup streak badges (7-day streak = 10% coupon), 24 h cart persistence (dual-enforced Redis + read-time guard).

### Phase 4 -- Multi-City & B2B Scale (5 features)

Catering/B2B orders (segregated from standard flow), multi-outlet chains (ownership guards, aggregate insights), 30-minute hyperlocal heatmap (public aggregate, 3-decimal geo), smart-watch app (<500 byte payloads, one-tap reorder), VIP customer support (50+ orders + Rs 5000+ spend → HIGH priority, OPS_AGENT auto-assign).

### UX Sprints 0-4 (5 sprints)

Foundation fix (RSC API base, WebSocket proxy, currency unification), UX foundation (middleware auth, checkout page, skeleton states), checkout reliability (dual-expiry cart, payment simulation robustness), PWA + accessibility (manifest, service worker, dark mode, WCAG 2.1 AA), i18n + A/B testing (en/hi 271 keys, feature flags, Grand UX Audit 24/24).

### Sprint 5 -- Admin Ops & Governance (11 features)

Edge middleware (JWT cookie check), OTP admin login, sidebar navigation (7 links), **kill switches** (3 default, DB-persisted, toggle UI), **vendor lifecycle** (suspend/reactivate with audit trail), **audit log viewer** (paginated, filterable), **live orders dashboard** (30s auto-refresh, status filter, detail expand, SUPER_ADMIN override), **user management** (search, suspend/reactivate, role promotion, suspended_reason), **support ticket oversight** (assignee dropdown, priority/status filters, status workflow), **vendor route RBAC** (requireRole on all vendor endpoints), **metrics dashboard** (CAC/LTV, sparkline trends, 60s auto-refresh). All 19 admin endpoints RBAC-gated: `adminReadOnly` (ADMIN, SUPER_ADMIN, OPS_AGENT) vs `adminWrite` (ADMIN, SUPER_ADMIN only).

> **Total: 36 features across 4 phases + 5 UX sprints + 1 admin sprint. 19 admin endpoints. 25 domain events. 7 bounded contexts.**

---

## Certification & Quality

### Grand Project Certification: GO

The entire platform has been certified under the **ZHEO v3 ECS** (Engineering Certification System) with the final Grand Project V2 sign-off:

| Dimension | Status | Evidence |
|-----------|--------|----------|
| **Functional** | PASS | 36 features, 25 events, full consumer → vendor → admin lifecycle |
| **Security** | PASS | JWT rotation, RBAC (adminReadOnly/adminWrite), SUPER_ADMIN gating, Edge middleware, vendor route guards, webhook HMAC |
| **Performance** | PASS | Watch payloads < 500 bytes, heatmap O(cells), group-cart per-token mutex, RSC-first streaming |
| **Resilience** | PASS | Webhook idempotency, order state machine integrity, cart dual-enforced TTL, kill-switch DB persistence |
| **Architecture (DDD)** | PASS | 7 strictly separated bounded contexts, anti-corruption repository injection |
| **EOS Event Catalog** | PASS | 25 typed events, zod-validated, acyclic dependency graph |
| **ZHEO v3 Full** | PASS | All 4 layers: PRD → EOS → EGS → ECS |

### Testing & Compliance

| Metric | Value |
|--------|-------|
| **Total Tests** | 386 (385 PASS, 1 pre-existing flaky timeout in P13 — not a blocker) |
| **Test Files** | 45 across all packages and apps |
| **Typecheck** | 3/3 apps PASS (api, admin, consumer) |
| **WCAG 2.1 AA** | 24/24 Grand UX Audit checks PASS |
| **PWA** | Service worker, web manifest, offline-first caching |
| **Idempotent Payments** | Razorpay webhook dedup + POS order dedup |
| **Audit Trail** | Every admin mutation logged (actor_id, action, metadata) |

### Certification Reports

```
work-logs/
├── phase-1/
│   ├── PHASE_1_AUDIT_REPORT.md        Phase 1 ECS certification matrix
│   └── final_certification.json       Phase 1 GO certificate
├── phase-2/
│   ├── PHASE_2_AUDIT_REPORT.md        Phase 2 ECS certification matrix
│   └── final_certification.json       Phase 2 GO certificate
├── phase-3/
│   ├── PHASE_3_AUDIT_REPORT.md        Phase 3 ECS certification matrix
│   └── final_certification.json       Phase 3 GO certificate
├── phase-4/
│   ├── PHASE_4_AUDIT_REPORT.md        Phase 4 ECS certification matrix
│   └── verification.json              Phase 4 GO certificate
├── sprint-4/
│   └── UX_GRAND_AUDIT_REPORT.md       WCAG 2.1 AA + UX compliance
├── sprint-5/
│   ├── ADMIN_AUDIT_REPORT.md          Pre-Sprint-5 gap analysis (11 open issues)
│   └── ADMIN_FINAL_AUDIT_REPORT.md    Sprint 5.2 final ECS matrix (11/11 closed)
└── GRAND_PROJECT_V2_CERTIFICATION.json  Final project sign-off (GO)
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **pnpm** >= 9.0.0
- PostgreSQL and Redis are **optional** for development — all services boot with in-memory repositories and demo data seeded automatically.

### Installation

```bash
# Clone the repository
git clone <repo-url> && cd snakzap

# Install all dependencies (monorepo)
pnpm install

# Configure environment variables
cp .env.example apps/api/.env
# Edit apps/api/.env if using real Postgres/Redis/Razorpay/Petpooja

# Start all 4 services (API + Consumer + Vendor + Admin)
pnpm dev
```

### Service Ports

| Service | URL | Dev Command |
|---------|-----|-------------|
| **Consumer App** | `http://localhost:3000` | `pnpm --filter @snakzap/consumer dev` |
| **API Server** | `http://localhost:3001` | `pnpm --filter @snakzap/api dev` |
| **Vendor App** | `http://localhost:3002` | `pnpm --filter @snakzap/vendor dev` |
| **Admin Console** | `http://localhost:3003` | `pnpm --filter @snakzap/admin dev` |

All frontend apps proxy `/api/*` to the API server via Vite/Next.js reverse proxy, so one exposed port per app serves the full stack.

### Verification

```bash
pnpm vitest run      # Full test suite (386 tests / 45 files)
pnpm typecheck        # Turbo typecheck all packages
pnpm lint             # Lint all packages
pnpm build            # Production build (all apps)
```

---

## Demo Access

| App | Access Method | Notes |
|-----|--------------|-------|
| **Consumer** | OTP login: any 6-digit OTP (e.g. `111111`) | Dev-mode bypass, no real SMS |
| **Vendor** | Phone `+919876000001`, OTP `111111` | Auto-logged as Chain Owner |
| **Admin** | Phone `+919876000003`, OTP `111111` | SUPER_ADMIN role; full RBAC access |
| **Payments** | `valid_sig_` signature prefix | Simulates successful Razorpay webhook |
| **POS** | `valid_sig_` signature prefix | Simulates successful Petpooja webhook |

> Real HMAC verification activates automatically when `RAZORPAY_WEBHOOK_SECRET` / `PETPOOJA_WEBHOOK_SECRET` are set in the environment.

---

## Architecture Notes

### Repository Pattern

All data access is abstracted behind repository interfaces with dual implementations:

- **Memory repositories** — used in dev and test; seeded with demo data on boot
- **Drizzle repositories** — used in production; PostgreSQL with full schema + migrations

Switching to production Postgres requires setting `DATABASE_URL` in the environment — no code changes needed.

### Middleware Stack (API)

```
Request
  → Rate Limiter (Redis sliding-window, fail-open)
    → authRequired (JWT validation + jti replay detection)
      → requireRole("VENDOR_OWNER", "ADMIN", ...) (RBAC gate)
        → adminReadOnly / adminWrite (granular admin RBAC)
          → Route Handler
            → Response Envelope {success, data, error}
```

### Middleware Stack (Admin)

```
Next.js Edge Middleware
  → Read snakzap_refresh cookie
    → Parse JWT expiry
      → Expired / absent → redirect to /login
        → Valid → continue to admin route
          → Client AuthGuard (UX enhancement)
            → localStorage Bearer token → API calls
```

### State Machine (Order Fulfillment)

```
DRAFT → PAYMENT_PENDING → CONFIRMED → PREPARING → ALMOST_READY → READY_FOR_PICKUP → PICKED_UP → SETTLED
                                                        ↑
                                               Geo-fence 100 m
                                               auto check-in triggers
```

- **Skipping states rejected** (e.g. CONFIRMED → ALMOST_READY returns 400)
- **Terminal state advance rejected** (SETTLED cannot transition further)
- **Order override** (SUPER_ADMIN only, audit-logged, with reason)

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | No | API port (default: 3001) |
| `NODE_ENV` | No | `development` / `production` |
| `DATABASE_URL` | No | PostgreSQL connection (falls back to in-memory repos) |
| `REDIS_URL` | No | Redis connection (falls back to in-memory cache) |
| `JWT_SECRET` | Yes | HS256 signing key for JWT tokens |
| `MSG91_AUTH_KEY` | No | SMS OTP provider (dev-mode bypass when absent) |
| `RAZORPAY_KEY_ID` | No | Razorpay API key |
| `RAZORPAY_KEY_SECRET` | No | Razorpay secret |
| `RAZORPAY_WEBHOOK_SECRET` | No | Razorpay webhook HMAC secret |
| `PETPOOJA_WEBHOOK_SECRET` | No | Petpooja webhook HMAC secret |
| `S3_BUCKET` | No | Menu photo storage (falls back to mock CDN) |

See `.env.example` for a complete template.

---

## License

Private repository. All rights reserved.

---

> _"SnakZap is more than a food app — it's a case study in how to build a governance-first, event-sourced, RBAC-gated platform with 36 features, 386 tests, and zero architectural debt."_  
> — Ultimate Strict Governance Enforcer, ZHEO v3 EOS Framework
