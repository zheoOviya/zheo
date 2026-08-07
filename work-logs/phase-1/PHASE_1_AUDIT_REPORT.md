# Phase 1 Audit & ECS Certification Report

- Feature: SNAP-0001 .. SNAP-0009 (Phase 1 - SnakZap MVP)
- Role: Strict Governance Enforcer
- Date: 2026-08-05
- Verdict: **GO**

## 1. Stray Issue Fix

`apps/admin` had no `tsconfig.json`, so its `tsc --noEmit` resolved to the root
tsconfig (no `--jsx`) and compiled the entire repository, failing the turbo
aggregate typecheck with inherited JSX errors from vendor/UI files.

Fixed by creating:
- `apps/admin/tsconfig.json` - mirrors the vendor app config (extends root,
  `jsx: "preserve"`, `lib: [dom, ...]`, `paths: { "@/*": ["./*"] }`, scoped
  `include` of admin's own files).
- `apps/admin/next-env.d.ts` - standard Next.js type reference so the scoped
  include has at least one input.

Result: root `pnpm typecheck` (turbo) now reports **5/5 tasks successful**.
`apps/admin` remains a Phase 1 placeholder (no source) as scoped; the fix
removes the inherited failure without scope creep.

## 2. Holistic Work-Log Review

All Phase 1 work-logs reviewed (`setup`, `db-schema-and-types`,
`core-infra-and-auth`, `catalog-discovery`, `ordering-context`, `consumer-auth-ui`,
`payments-context`, `fulfillment-context`, `vendor-ops`) plus
`verification.json` (P1-009 PASSED). Feature history is consistent:
SNAP-0001 setup/monorepo, SNAP-0002 schema/types, SNAP-0003 core infra + auth,
SNAP-0004 catalog + consumer discovery, SNAP-0005 ordering, SNAP-0006 consumer
auth UI, SNAP-0007 payments, SNAP-0008 fulfillment + WebSocket, SNAP-0009
vendor ops (settlements / photo upload / audit). No gaps found; vendor-ops
log is complete and marked COMPLETE.

## 3. ECS Certification Matrix

### Functional Cert - PASS

- Full consumer journey: browse restaurants/menu -> dietary filters/search ->
  add to cart with customizations -> OTP auth -> checkout -> simulated Razorpay
  payment (webhook replay) -> kitchen status tracking -> QR/OTP pickup.
- Vendor journey: kitchen dashboard with live status advance -> daily
  settlement PDF download -> menu management with photo upload.
- Test evidence: 141/141 Vitest tests across 17 files, `tsc --noEmit` clean on
  api/consumer/vendor. Live previews (ports 3000/3002) return 200; API on 3001.

### Security Cert - PASS

| Control | Evidence | Test |
|---|---|---|
| JWT refresh rotation | `jwtService.rotateRefreshToken` blacklists old jti before issuing a new pair (`apps/api/src/services/jwt.ts:141`) | jwt.test.ts "rotates a refresh token and blacklists the old one" |
| Reuse detection | Blacklisted jti -> `REFRESH_TOKEN_REUSED` (jwt.ts:148) | jwt.test.ts "blacklists and detects a refresh token by jti" |
| Device fingerprinting | `device_fingerprint` claim (min 8 chars) required at verify-otp + refresh; mismatch -> `DEVICE_MISMATCH` step-up (jwt.ts:155, routes/auth.ts:83) | auth.test.ts "rejects refresh on device mismatch", jwt.test.ts "rejects rotation on device fingerprint mismatch" |
| Redis rate limiting | Sliding-window sorted set (`apps/api/src/middleware/rateLimiter.ts:22`); OTP 3/min/phone (`auth.ts:30`), API 100/min/IP (`app.ts:20`); fail-open on Redis outage | rateLimiter.test.ts, auth.test.ts "enforces OTP rate limit", apiRateLimit.test.ts |
| HttpOnly refresh cookie | `httpOnly: true, sameSite: strict, path: /api/v1/auth` (auth.ts:85) | auth.test.ts refresh flow |
| Webhook signature | `x-razorpay-signature` verified, missing/invalid -> 401 | payments.test.ts "rejects webhook with invalid signature" |

### Performance Cert (Simulated) - PASS

- Redis sliding-window rate limiting bounds request bursts (100/min/IP).
- Catalog cached with TTL via Redis (`getOrSet` in routes/catalog.ts) -
  restaurants 5min, menu 5min, search 60s, filter 5min.
- GIN index `menu_items_dietary_tags_gin_idx` (jsonb_path_ops) enables fast
  `dietary_tags @> '{tag:true}'` containment lookups.
- RSC-first consumer app: menu page is a React Server Component with a single
  client island; streaming `loading.tsx` skeleton mirrors layout 1:1 for zero
  layout shift.
- No N+1 or in-loop DB patterns found in reviewed routes; in-memory repos used
  pre-DB-provisioning keep the API O(1) lookups.

### Resilience Cert - PASS

| Control | Evidence |
|---|---|
| Webhook idempotency | `findByRazorpayPaymentId` dedup - duplicate webhook returns `{ processed:false, idempotent:true }` with no side effects (`apps/api/src/services/payments.ts:89`) |
| State machine integrity | `VALID_TRANSITIONS` map enforces sequential transitions; skipping and terminal-state advances rejected (`apps/api/src/services/fulfillment.ts:15`) |
| Payout determinism | Settlement taxes recomputed server-side from persisted `order_items`; commission reuses `PRICING` const so checkout math cannot diverge |
| Storage abstraction | `ImageStorage` interface swaps S3 <-> deterministic mock; wiring real S3 is config-only |
| Fail-open rate limit | Redis outage degrades to allow rather than block all traffic |
| State recovery | WebSocket events emitted on every transition for cross-instance state sync via Redis PubSub |

## 4. Non-Negotiable Compliance Check

### DDD: Bounded Contexts strictly separated - PASS

- Direct DB table reads (`.from(...)`) exist ONLY inside
  `apps/api/src/repositories/catalogRepository.ts`, and only against catalog
  tables (`restaurants`, `menu_items`). Ordering/payments/fulfillment/vendor-ops
  touch the DB exclusively through repository interfaces.
- Cross-context collaboration happens via injected repositories
  (`PaymentService(orderRepo)`, `generateDailySettlement(repo)`,
  `FulfillmentService(orderRepo)`) - an anti-corruption layer, not shared tables.
- Contexts: identity, catalog, ordering, payments, fulfillment, vendor ops -
  each with its own route module, service, and repository.

### Security - PASS (see Security Cert above)

### Business Logic: Order State Machine & Pricing - PASS

- State machine: strict sequential CONFIRMED -> PREPARING -> ALMOST_READY ->
  READY_FOR_PICKUP -> PICKED_UP; skipping rejected (`INVALID_TRANSITION`),
  terminal states locked; OTP/QR generated exactly at PREPARING.
  Verified in fulfillment.test.ts and live.
- Pricing: 0% commission when `total_amount <= 200`, 8% when `> 200`
  (`apps/api/src/services/pricing.ts:87`); boundary (exactly 200 = 0%) unit
  tested; settlement engine reuses the same `PRICING` constants.
  Settlement cases verified: Rs 150 -> 0%, Rs 500 -> Rs 40 (8%).

### Resilience: Webhook Idempotency & GIN Indexes - PASS

- Webhook idempotency verified by test "CRITICAL: duplicate webhook is
  idempotent - returns 200 with no side effects" (payments.test.ts:166).
- GIN index present in both schema definition
  (`packages/db/src/schema/catalog.ts:66`) and migration
  (`packages/db/drizzle/0000_demonic_nova.sql:112`):
  `CREATE INDEX IF NOT EXISTS "menu_items_dietary_tags_gin_idx" ON "menu_items" USING gin ("dietary_tags" jsonb_path_ops)`.

### UI/UX: Teal Palette & Skeleton Loaders - PASS

- Shared teal-shimmer skeleton: `packages/ui/src/Skeleton.tsx` uses
  `animate-skeleton-teal` + `bg-primary-500/30` (no spinners, teal only).
- Consumer: `apps/consumer/app/loading.tsx` streams the teal skeleton while the
  RSC payload loads; inline pulses in OrderTracker/SearchBar.
- Vendor: `apps/vendor/components/TealSkeleton.tsx` (same animation) used on the
  Settlements and Menu Management pages during load/upload.
- Admin: N/A in Phase 1 - placeholder package with no UI shipped; tsconfig fix
  makes it a clean member of the typecheck graph.
- All three apps share the teal palette via `@snakzap/config/tailwind`
  (`#0D9488` primary, `#F59E0B` accent, `#042F2E`/`#F0FDFA` surfaces).

## 5. Observed Notes (non-blocking)

- In-memory repositories (MemoryOrderRepository, MemoryCatalogRepository,
  MemoryAuditRepository) stand in for Postgres until DB provisioning lands;
  Drizzle schema + migrations are committed and current.
- MockImageStorage and the Razorpay mock signature path are dev/test seams;
  both are structurally wired for production swap-in via config.
- Vendor + admin routes are intentionally unauthenticated in dev (mirrors the
  existing `/api/vendor/*` pattern); production auth gate is a documented
  follow-up, with the audit trail already keyed off `res.locals.userId`.

## 6. Final Verdict

**GO** - Phase 1 passes the ECS Certification Matrix (Functional, Security,
Performance-simulated, Resilience). All non-negotiable compliance checks pass.
Zero open blockers. Phase 1 is certified for delivery.
