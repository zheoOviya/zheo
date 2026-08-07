# Work-Log: Phase 1 - Consumer Auth UI & Protected Checkout Flow
**Date**: 2026-08-05
**Feature ID**: P1-006-CONSUMER-AUTH-UI
**Status**: COMPLETE

## Objective
Bridge the Backend Auth system (P1-003) with the Consumer Frontend. Implement the OTP login flow, device-bound token management (Access in Zustand memory, Refresh in HttpOnly cookie), Next.js Middleware for protected routes, and enforce JWT-based authorization on the ordering endpoint.

## OTP Login Flow (PRD Phase 1, EOS Layer 2.3)
1. User enters phone number -> `POST /api/v1/auth/send-otp`
2. User enters 6-digit OTP -> `POST /api/v1/auth/verify-otp`
3. Server returns `access_token` (15min) + sets `snakzap_refresh` cookie (7d HttpOnly)
4. Client stores access token in Zustand (memory only)
5. Client generates a mock `device_fingerprint` (stored in localStorage, passed in `x-device-fingerprint` header)

## Token Management Strategy
| Token | Storage | TTL | Purpose |
|-------|---------|-----|---------|
| Access | Zustand (memory) | 15 min | API authorization (Bearer header) |
| Refresh | HttpOnly cookie | 7 days | Silent refresh (rotation with jti blacklist) |
| Device Fingerprint | localStorage | persistent | Device binding (step-up auth on mismatch) |

## Protected Routes
- `/checkout` - requires valid session (checked via Next.js Middleware + client-side auth gate)
- Middleware inspects `snakzap_refresh` cookie; if absent, redirects to `/login`
- Client-side auth gate in checkout page checks Zustand store; triggers silent refresh on missing access token

## Backend Auth Middleware
- `authenticate` middleware verifies `Authorization: Bearer <token>`
- Extracts `user_id` from JWT payload `sub` claim -> sets `res.locals.userId`
- Returns `401 UNAUTHORIZED` on missing/invalid/expired token
- Applied to `POST /api/v1/orders` and `POST /api/v1/orders/reorder`

## Target Files
Backend:
- `apps/api/src/middleware/auth.ts` (new - JWT verification middleware)
- `apps/api/src/routes/orders.ts` (update - apply auth middleware, extract user_id from JWT)
- `apps/api/src/middleware/auth.test.ts` (new)

Frontend:
- `apps/consumer/lib/store.ts` (update - add auth slice to Zustand)
- `apps/consumer/lib/api.ts` (update - add authenticated fetcher)
- `apps/consumer/app/login/page.tsx` (new - mobile-first OTP login)
- `apps/consumer/components/PhoneInput.tsx` (new)
- `apps/consumer/components/OtpInput.tsx` (new)
- `apps/consumer/middleware.ts` (new - route protection)
- `apps/consumer/app/checkout/page.tsx` (new - protected page)
- `apps/consumer/app/checkout/layout.tsx` (new - auth gate wrapper)

Tests:
- `apps/api/src/middleware/auth.test.ts`
- `apps/api/src/routes/orders.test.ts` (update - add 401 scenario)
- `apps/consumer/__tests__/auth-flow.test.tsx`

## Verification Criteria (ECS)
- [x] Auth middleware returns 401 on missing/invalid/expired token
- [x] POST /orders rejects unauthenticated requests with 401
- [x] POST /orders extracts user_id from JWT sub claim, not request body
- [x] Login screen: mobile-first phone + OTP with auto-focus
- [x] OTP input: 6-digit boxes, teal focus, auto-advance
- [x] Access token stored in Zustand memory (never in localStorage)
- [x] Device fingerprint generated client-side and sent in x-device-fingerprint
- [x] Next.js Middleware redirects unauthenticated /checkout to /login
- [x] Silent refresh: expired access token triggers refresh via cookie
- [x] Vitest tests pass (auth middleware + ordering 401 + frontend auth flow) - 91 tests, 13 files
- [x] verification.json generated
