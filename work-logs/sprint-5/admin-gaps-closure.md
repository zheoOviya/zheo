# Sprint 5.1 - Admin Critical Gaps Closure

**Date:** 2026-08-07
**Status:** In Progress
**Phase:** Sprint 5 (Admin Ops & Governance) - Gap Closure

## Overview

Sprint 5 left 8 PARTIAL and 2 OPEN gaps out of 11 admin audit issues (ADMIN_AUDIT_REPORT.md). This sprint closes the critical security, persistence, and RBAC gaps before new features proceed.

## Gap Analysis

| Issue | Sprint 5 Status | Target |
|-------|----------------|--------|
| A-01 | PARTIAL (client-only AuthGuard) | Server-side Edge middleware |
| A-03 | PARTIAL (in-memory kill switches) | DB-persisted with repository pattern |
| A-11 | PARTIAL (no OPS_AGENT read-only) | Granular RBAC with read-only role |
| A-04 | PARTIAL (single toggle endpoint) | Distinct suspend/reactivate + audit |
| A-10 | PARTIAL (missing CAC/LTV) | Compute CAC/LTV in metrics endpoint |

## Task 1: Server-Side Admin Auth (A-01)

**File:** `apps/admin/middleware.ts`
- Next.js Edge Middleware protecting all `/admin/*` routes
- Reads `snakzap_refresh` cookie (HttpOnly, SameSite=Strict)
- Verifies JWT refresh token, extracts role
- Redirects to `/login` if absent/invalid
- Client-side AuthGuard remains as UX enhancement (hydrated state protection)

**Verification:**
- `apps/admin/__tests__/middleware.test.ts`: unauthenticated requests → 307 redirect to `/login`

## Task 2: Kill Switch DB Persistence (A-03)

**Files:**
- `packages/db/src/schema/killswitches.ts`: `kill_switches` table
- `apps/api/src/repositories/killSwitchRepository.ts`: KillSwitchRepository interface + Memory + Drizzle implementations
- `apps/api/src/routes/admin.ts`: Refactored to use repository

**Schema:**
```
kill_switches: id(UUID PK), switch_name(TEXT UNIQUE), is_triggered(BOOL), threshold_value(FLOAT), current_value(FLOAT), updated_at(TIMESTAMPTZ)
```

**Endpoints:**
- `GET /api/v1/admin/kill-switches` - list all (adminReadOnly)
- `PUT /api/v1/admin/kill-switches/:id` - toggle (adminWrite only)

**Verification:**
- `apps/api/src/routes/admin.test.ts`: kill switch state survives across repo re-init

## Task 3: OPS_AGENT Role (A-11)

**File:** `apps/api/src/middleware/requireRoles.ts`
- Added `adminReadOnly = requireRole("ADMIN", "SUPER_ADMIN", "OPS_AGENT")`
- Read routes: dashboard, orders, vendors list, kill-switches list, audit-logs → use `adminReadOnly`
- Write routes: kill-switch toggle, vendor suspend/reactivate → use `adminWrite`

**Verification:**
- Tests proving OPS_AGENT token gets 200 on GET endpoints, 403 on POST/PUT endpoints

## Task 4: Vendor Lifecycle + Metrics (A-04, A-10)

**File:** `apps/api/src/routes/admin.ts`
- `PUT /api/v1/admin/vendors/:id/suspend` - adminWrite only, audit-logged
- `PUT /api/v1/admin/vendors/:id/reactivate` - adminWrite only, audit-logged
- Metrics endpoint now returns `cac_amount`, `ltv_amount`, `cac_ltv_ratio`

**CAC/LTV Calculation:**
- CAC = total_marketing_spend (mock: 5000 INR) / total_acquired_users
- LTV = average_order_value * avg_orders_per_user * avg_customer_lifespan_months
- Default mock values when no real data available

## Files Changed

| File | Action |
|------|--------|
| `work-logs/sprint-5/admin-gaps-closure.md` | CREATE |
| `apps/admin/middleware.ts` | CREATE |
| `packages/db/src/schema/killswitches.ts` | CREATE |
| `packages/db/src/schema/index.ts` | MODIFY (export killswitches) |
| `apps/api/src/repositories/killSwitchRepository.ts` | CREATE |
| `apps/api/src/routes/admin.ts` | REFACTOR (persistent KS, OPS_AGENT, vendor lifecycle, CAC/LTV) |
| `apps/api/src/middleware/requireRoles.ts` | MODIFY (export adminReadOnly + adminWrite) |
| `apps/api/src/repositories/shared.ts` | MODIFY (add killSwitchRepo) |
| `apps/admin/lib/api.ts` | MODIFY (update endpoints) |
| `apps/api/src/routes/admin.test.ts` | CREATE (RBAC + KS persistence tests) |
| `work-logs/sprint-5/verification.json` | CREATE |
