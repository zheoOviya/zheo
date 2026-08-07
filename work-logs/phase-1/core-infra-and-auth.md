# Work-Log: Phase 1 - Core Backend Infrastructure & Auth System
**Date**: 2026-08-04
**Feature ID**: P1-003-CORE-INFRA-AND-AUTH
**Status**: COMPLETE

## Objective
Build the foundational backend infrastructure in `apps/api`:
1. Express + TypeScript with global API Envelope and `/api/v1/` versioning.
2. Winston structured JSON logging + `x-correlation-id` propagation.
3. Redis sliding-window rate limiting (OTP: 3/min/phone, API: 100/min/IP).
4. MSG91 OTP auth -> JWT (15 min access + 7 day refresh in HttpOnly cookie), refresh rotation, device binding.
5. Config module simulating a Central Config Registry (env-driven, zero hardcoded secrets).

## Architecture Overview

### Auth Flow
```
1. POST /api/v1/auth/send-otp { phone }          -> MSG91, OTP stored in Redis (5 min TTL)
2. POST /api/v1/auth/verify-otp { phone, otp, device_fingerprint } -> issues access + refresh JWT
3. POST /api/v1/auth/refresh (HttpOnly cookie)   -> rotates refresh token, blacklists old
```

### JWT Strategy (EGS 2.3)
- Access Token: 15 min TTL (signed with `JWT_SECRET`).
- Refresh Token: 7 days TTL, stored in HttpOnly cookie (signed with `JWT_REFRESH_SECRET`).
- Refresh Token Rotation: MANDATORY - on `/auth/refresh`, old token is blacklisted in Redis and a new pair issued.
- Device Binding: `device_fingerprint` captured at verify-otp, embedded in JWT claims; mismatched device on refresh -> rejected -> step-up auth (new OTP).

### Rate Limiting (PRD Section 4)
- Sliding window via Redis sorted sets (ZADD / ZREMRANGEBYSCORE / ZCARD in a MULTI).
- OTP route: max 3 req/min/phone (`rl:otp:{phone}`).
- General API: max 100 req/min/IP (`rl:api:{ip}`).
- `429` -> envelope `{ success:false, data:null, error:{ code:"RATE_LIMIT_EXCEEDED", ... } }`.

### Observability (EOS 1.5)
- Winston JSON logger; every request gets a generated `x-correlation-id` (or reuses inbound one).
- Correlation ID attached to all request-scoped logs and propagated into emitted events/outbound headers.
- `/metrics` placeholder exposing Prometheus RED counters (rate/errors/duration) with memory-array backend (no deps).

### API Governance (EOS 1.4)
- Base path `/api/v1/`.
- Envelope middleware wraps all handlers; success/error envelopes enforced by an `asyncHandler` wrapper.

## Target Files
- `apps/api/src/config.ts`
- `apps/api/src/lib/logger.ts`
- `apps/api/src/lib/correlation.ts`
- `apps/api/src/lib/redis.ts`
- `apps/api/src/middleware/envelope.ts`
- `apps/api/src/middleware/rateLimiter.ts`
- `apps/api/src/middleware/errorHandler.ts`
- `apps/api/src/services/jwt.ts`
- `apps/api/src/services/otp.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/metrics.ts`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- `apps/api/src/**/*.test.ts`

## Verification Criteria (ECS)
- [x] Envelope middleware enforces `{ success, data, error }` on all routes
- [x] Auth routes issue valid access + refresh tokens
- [x] Refresh rotation blacklists the old token
- [x] Device mismatch triggers step-up auth rejection
- [x] OTP rate limit blocks >3/min/phone
- [x] API rate limit blocks >100/min/IP
- [x] All responses pass Zod envelope validation
- [x] Vitest suite passes (21/21); verification.json generated

## Evidence
Full machine-readable evidence: `work-logs/phase-1/verification.json`
- Tests: 21/21 PASS (api), 47/47 full repo
- Coverage: apps/api/src 85.71% lines
- Typecheck + build: PASS
- Auth flow, rotation, device binding, both rate limits: certified
