# Sprint 6 - Reality Check & Production Hardening

**Date:** 2026-08-07
**Status:** In Progress
**Phase:** Post-Certification Hardening

## External Review Findings

An external architectural review identified three critical issues:

1. **Duplicate Code & Dead Handlers** -- `apps/api/src/routes/orders.ts` contains a duplicate `ListOrdersQuerySchema` const (page-based at line 40, cursor-based at line 49) and a dead `ordersRouter.get("/")` handler (lines 105-151) that is unreachable because an earlier handler for the same route already handles the request. The page-based schema never takes effect because the cursor-based schema shadows it.

2. **In-Process Event Bus** -- `apps/api/src/lib/eventBus.ts` uses an in-memory `Map` for event handlers. Events are not persisted, not published across instances, and are lost on process restart. The README claimed this was a "production" system but the event bus is single-process-only.

3. **Rate Limiter Fail-Open** -- `apps/api/src/middleware/rateLimiter.ts` returns `{ allowed: true }` on Redis failure. This means a Redis outage disables all rate limiting (auth, payments, OTP), allowing unlimited requests. For security-critical endpoints this is a vulnerability.

## Fixes Applied

### Task 1: Remove Duplicate Code (orders.ts)
- Removed first `ListOrdersQuerySchema` const (line 40-43) that was shadowed
- Removed dead second `ordersRouter.get("/")` handler (lines 105-151)
- Kept the working cursor-based handler

### Task 2: Redis Pub/Sub Event Bus
- Added `onMessage` callback support to `RedisLike` interface
- Refactored `emit()` to publish events to Redis channel `snakzap:events`
- Subscriber client listens on the same channel and dispatches to local handlers
- In-process dispatch still runs first for same-process performance
- Falls back to in-process-only when Redis is unavailable

### Task 3: Rate Limiter Fail-Closed
- Added `failClosed: boolean` option to `RateLimiterOptions`
- When `failClosed: true` and Redis fails, returns `{ allowed: false }` causing 503
- Applied fail-closed to auth/OTP routes, payments, and admin write endpoints
- Kept fail-open for general API limiter (non-critical reads)

### Task 4: Truthful README + MIT License
- Removed "Zero-Hallucination enforcement", "Zero architectural debt" claims
- Stated Redis-backed event bus
- Positioned as "Startup-grade / Portfolio" project
- Added MIT LICENSE file
