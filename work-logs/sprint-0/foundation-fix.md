# Sprint 0: Reality Check & Foundation Fix

## Date: 2026-08-07
## Status: IN PROGRESS
## Sprint Lead: AI Agent (MonkeyCode-AI)
## ZHEO v3 EOS Compliance: Target

---

## Audit Summary

A comprehensive UX and infrastructure audit of the SnakZap monorepo (7 consumer pages, 10 vendor pages, 2 admin pages, 17 API route files, 292 backend tests) was completed. The audit revealed 5 critical and multiple high/medium severity issues that must be addressed before any new UX features.

### Key Findings (Full Audit Section)

| ID | Issue | Current State | Target State |
|----|-------|---------------|-------------|
| I-23 | In-Memory Repositories | 10 Memory*Repository classes with Map-based storage. Data lost on server restart | Drizzle ORM-backed repositories with PostgreSQL persistence |
| I-02 | Fake QR Code | SVG placeholder with manual rect finder patterns, not scannable | Real QR code via `qrcode` npm library, error correction H, 200x200dp |
| I-05 | Simulated Payments | "Simulate Success"/"Simulate Failure" buttons in checkout | Real Razorpay Checkout SDK integration with UPI/Cards/Netbanking |
| I-21 | No Error Boundaries | Zero `error.tsx` files in any app (consumer/vendor/admin) | Teal-themed error boundaries at root layout level in all 3 apps |
| I-22 | No 404 Pages | Zero `not-found.tsx` files in any app | Custom 404 pages with navigation CTAs in all 3 apps |

---

## Fix I-23: Real Database Connection (CRITICAL)

### Current Architecture
- `apps/api/src/repositories/shared.ts` instantiates 10 `Memory*Repository` singletons
- Each repository uses `Map<string, DTO>` for data storage
- Server restart = complete data loss
- `catalogRepository.ts` is the ONLY repository with a partial Drizzle implementation (`DrizzleCatalogRepository`)
- Drizzle ORM (`drizzle-orm ^0.36.0`) is already a dependency
- 7 SQL migrations exist under `packages/db/drizzle/`
- Schema is fully defined (8 tables: users, audit_logs, chains, restaurants, menu_items, orders, order_items, payments, order_status_history)
- `pg` (node-postgres) is NOT in dependencies - needs to be added

### Changes Required
1. Add `pg` dependency to `apps/api`
2. Create `apps/api/src/lib/db.ts` - Drizzle client factory with `drizzle-orm/node-postgres`
3. Create `apps/api/src/lib/dbType.ts` - Shared `DrizzleDb` type (extracted from catalogRepository)
4. Refactor each Memory*Repository to Drizzle*Repository:
   - `identityRepository.ts` -> `DrizzleIdentityRepository` using `users` table
   - `orderRepository.ts` -> `DrizzleOrderRepository` using `orders` + `order_items` tables
   - `paymentRepository.ts` -> `DrizzlePaymentRepository` using `payments` table
   - `auditRepository.ts` -> `DrizzleAuditRepository` using `audit_logs` table
   - `loyaltyRepository.ts` -> `DrizzleLoyaltyRepository` using in-memory for non-DB concepts (wallet, streaks, stamp cards need their own tables; for now, add loyalty tables)
   - `groupCartRepository.ts` -> `DrizzleGroupCartRepository` using Redis or dedicated table
   - `chainRepository.ts` -> `DrizzleChainRepository` using `chains` table + `restaurants.chain_id`
   - `supportRepository.ts` -> `DrizzleSupportRepository` using dedicated table
   - `posRepository.ts` -> `DrizzlePosRepository` using dedicated table
   - `promotionRepository.ts` -> `DrizzlePromotionRepository` using dedicated table
5. Update `shared.ts` to create Drizzle instances instead of Memory instances
6. Update `seed/phase4Demo.ts` to seed data into PostgreSQL via Drizzle

### Backward Compatibility
- Memory*Repository classes preserved for test usage via factory pattern
- Environment variable `USE_MEMORY_REPOS=true` enables memory mode for testing
- Default (production) uses Drizzle + PostgreSQL

---

## Fix I-02: Real QR Code Generation (CRITICAL)

### Current Architecture
- `apps/consumer/components/QrCode.tsx` draws a FAKE SVG using manual `<rect>` elements
- The "data modules" section uses `(seed >> (row * 7 + col)) & 1` to generate a non-scannable pattern
- Comment on line 14: "This is a placeholder - real QR codes need qrcode library"

### Changes Required
1. Add `qrcode` npm package to `apps/consumer` dependencies
2. Add `@types/qrcode` to devDependencies
3. Rewrite `QrCode.tsx`:
   - Generate QR code via `QRCode.toDataURL(value, { errorCorrectionLevel: 'H', width: 400 })`
   - Display as `<img>` with `srcSet` for retina displays
   - Keep existing tap-to-enlarge functionality
   - Keep existing OTP text display (accessible fallback)
   - Add "Copy OTP" button with clipboard API
   - QR encodes `{ orderId, otp, v: 1 }` as JSON string

---

## Fix I-05: Real Razorpay Checkout SDK (HIGH)

### Current Architecture
- `apps/consumer/app/checkout/page.tsx` has hardcoded "Simulate Success"/"Simulate Failure" buttons
- Backend API: `POST /api/v1/payments/create-order` returns real `razorpay_order_id`, `amount`, `key_id`
- Backend webhook: `POST /api/v1/payments/webhook` handles HMAC-signed Razorpay callbacks
- The entire payment pipeline works correctly on the backend; only the frontend SDK integration is missing

### Changes Required
1. Load Razorpay checkout script via Next.js `<Script strategy="lazyOnload">`
2. Create `apps/consumer/lib/razorpay.ts` - typed wrapper for `Razorpay` global
3. Rewrite checkout payment step:
   - Call `/api/v1/payments/create-order` (already working)
   - Open `Razorpay(options).open()` with UPI as default payment method
   - `handler` callback: trigger webhook simulation, redirect to `/orders/[id]`
   - `modal.dismiss` handler: show error toast
   - Payment timeout: 5-minute countdown display
4. Add Razorpay key ID to environment config (`NEXT_PUBLIC_RAZORPAY_KEY_ID`)
5. Keep simulation mode for dev via env var `NEXT_PUBLIC_PAYMENT_MODE=simulate`
6. Add proper `prefill.contact` from authenticated user phone

---

## Fix I-21 & I-22: Error Boundaries & 404 Pages

### Changes Required
Add to all three apps:
1. `apps/consumer/app/error.tsx` - Teal-themed error boundary
2. `apps/vendor/app/error.tsx` - Dark-mode error boundary
3. `apps/admin/app/error.tsx` - Admin-themed error boundary
4. `apps/consumer/app/not-found.tsx` - 404 with navigation CTA
5. `apps/vendor/app/not-found.tsx` - 404 with vendor nav CTA
6. `apps/admin/app/not-found.tsx` - 404 with admin nav CTA

---

## Verification Plan

### I-23 Verification
- [ ] `npm run typecheck` passes for `apps/api`
- [ ] Drizzle client connects to PostgreSQL (or gracefully handles missing DB in dev)
- [ ] All route tests pass with Drizzle repositories
- [ ] New migration applied if needed
- [ ] Seed data persists across server restarts

### I-02 Verification
- [ ] `npm run typecheck` passes for `apps/consumer`
- [ ] QR code renders as valid base64 image
- [ ] QR code is scannable by a real QR reader
- [ ] OTP copy-to-clipboard works
- [ ] Brightness boost modal works on mobile

### I-05 Verification
- [ ] `npm run typecheck` passes for `apps/consumer`
- [ ] Razorpay modal opens on "Place Order" click
- [ ] UPI/Card/Netbanking options render
- [ ] Success callback navigates to order tracking
- [ ] Failure shows inline retry
- [ ] Simulation mode still works via env variable

### I-21/I-22 Verification
- [ ] Error boundaries render on component crash
- [ ] "Try Again" button reloads the page
- [ ] 404 pages render for non-existent routes
- [ ] Navigation CTAs work correctly
