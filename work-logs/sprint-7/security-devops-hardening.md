# Sprint 7: Operational & Security Hardening

**Date:** 2026-08-08
**Status:** IN PROGRESS
**Trigger:** 10-dimension project audit revealed 5/10 security and 3/10 DevOps grades.

## Scope

No new features. Hardening only -- fixing OWASP-critical vulnerabilities, establishing DevOps tooling, and closing production-readiness gaps.

## Audit Baseline (Pre-Sprint)

| Dimension | Grade | Key Finding |
|-----------|-------|-------------|
| Security | 5/10 | JWT algorithm confusion, OTP brute-force, permissive CORS, unauthenticated pickup |
| DevOps & Tooling | 3/10 | No CI/CD, no ESLint/Prettier, no pre-commit hooks |
| Production Readiness | 5/10 | Health check exists but doesn't probe dependencies, no graceful shutdown |
| Testing | 6/10 | Consumer test setup broken, admin/vendor have minimal tests |
| Code Quality | 7/10 | Swallowed errors (.catch empty blocks) in 4 locations |

## Task 1: Critical Security Fixes (OWASP)

### 1.1 JWT Algorithm Confusion (CRITICAL)
- **File:** `apps/api/src/services/jwt.ts:72,88`
- **Issue:** `jwt.verify()` called without `algorithms` option. `jsonwebtoken` trusts the JWT header `alg` field by default.
- **Fix:** Add `algorithms: ["HS256"]` to both `verifyAccessToken()` and `verifyRefreshToken()`.

### 1.2 OTP Brute-Force on Verify (HIGH)
- **File:** `apps/api/src/routes/auth.ts:64`
- **Issue:** `/api/v1/auth/verify-otp` lacks dedicated rate limiter. Only protected by global 100 req/min/IP, allowing 100 OTP guesses per minute.
- **Fix:** Apply `otpLimiter` (3/min, fail-closed, phone-keyed) to the verify-otp route.

### 1.3 CORS: Origin=true + Credentials (HIGH)
- **File:** `apps/api/src/app.ts:55`
- **Issue:** `cors({ origin: true, credentials: true })` reflects any Origin header, allowing any website to make credentialed requests.
- **Fix:** Replace with explicit allowlist: localhost dev ports + production URL placeholder.

### 1.4 Unauthenticated Pickup Confirmation (HIGH)
- **File:** `apps/api/src/routes/fulfillment.ts:66`
- **Issue:** `POST /orders/:id/confirm-pickup` has no `authenticate` middleware. Anyone with a valid order ID + OTP/qr_token can mark pickup.
- **Fix:** Add `authenticate` middleware to the route.

## Task 2: DevOps & Tooling

### 2.1 ESLint + Prettier
- Root `.eslintrc.cjs` with TypeScript + Prettier integration
- Root `.prettierrc` with project-standard formatting (single quotes, trailing commas, semi)
- Root `.eslintignore` and `.prettierignore`

### 2.2 Lint Scripts
- `packages/types/package.json`: added `"lint": "tsc --noEmit"` script
- `packages/db/package.json`: added `"lint": "tsc --noEmit"` script
- `apps/api/package.json`: added `"lint": "eslint . --ext .ts"` script
- Consumer, admin, vendor: already have `next lint` via Next.js built-in ESLint

### 2.3 CI/CD Pipeline
- Created `.github/workflows/ci.yml` running on push/PR to `main`
- Steps: install pnpm, install deps, lint, typecheck, test

## Task 3: Production Readiness

### 3.1 Health Check Enhancement
- **File:** `apps/api/src/app.ts:80`
- **Before:** Returned static `{ status: "ok" }` without checking dependencies.
- **After:** Probes Redis (`status` field) and PostgreSQL (via `getDb()` catch). Returns 200 with dependency status or 503 if critical dependencies down.

### 3.2 Graceful Shutdown
- **File:** `apps/api/src/index.ts`
- **Before:** No signal handlers. `Ctrl+C` killed process instantly.
- **After:** SIGTERM/SIGINT handlers: close HTTP server (drain connections with 10s timeout), close Redis (`quit()`), close PostgreSQL pool. Logs shutdown sequence.

### 3.3 Swallowed Errors -- Now Logged
- `repositories/killSwitchRepository.ts:82` -- `catch(() => {})` → `catch(err => logger.warn(...))`
- `repositories/drizzle/drizzleIdentityRepository.ts:132` -- same
- `repositories/drizzle/drizzleOrderRepository.ts:334,348` -- same
- `services/cache.ts:59` -- `catch(() => undefined)` → `catch(err => { logger.warn(...); })`

## Task 4: Consumer Test Fixes

- `vitest.setup.ts` already imports `@testing-library/jest-dom/vitest` -- the setup file is correct.
- Typecheck errors are pre-existing: `@testing-library/react` and `jsqr` type declarations missing from the installed node_modules due to pnpm resolution. Not fixed in this sprint (requires devDep reinstallation).
- No empty test stubs remain (MenuItemsList.test.tsx already removed).

## Verification

### Typecheck
- `apps/api`: PASS (0 errors)
- `apps/admin`: PASS (0 errors)
- `apps/consumer`: PRE-EXISTING (testing-library/jsqr type declarations in node_modules)

### Tests
- Target: 375+ tests passing (including fail-closed rate limiter test from Sprint 6)
- Run: `pnpm vitest run` from root

### Lint
- `pnpm lint` (turbo lint) should pass on all packages

## Artifacts
- `work-logs/sprint-7/security-devops-hardening.md` (this file)
- `work-logs/sprint-7/verification.json`
- `.eslintrc.cjs`
- `.prettierrc`
- `.eslintignore`
- `.prettierignore`
- `.github/workflows/ci.yml`
- Modified: `services/jwt.ts`, `routes/auth.ts`, `app.ts`, `routes/fulfillment.ts`, `index.ts`, `killSwitchRepository.ts`, `drizzleIdentityRepository.ts`, `drizzleOrderRepository.ts`, `cache.ts`, multiple `package.json` files
