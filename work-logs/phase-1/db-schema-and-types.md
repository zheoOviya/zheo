# Work-Log: Phase 1 - DB Schema & Domain Types (DDD)
**Date**: 2026-08-04
**Feature ID**: P1-002-DB-SCHEMA-AND-TYPES
**Status**: COMPLETE

## Objective
Create the foundational data layer for Phase 1:
1. Drizzle ORM schemas separated by DDD Bounded Contexts (`identity`, `catalog`, `ordering`, `payments`, `fulfillment`).
2. Domain types, Zod validation schemas, and the Event Catalog in `packages/types`.
3. Strict adherence to PRD Section 4 (System Contracts) and EOS Layer 1.

## Bounded Contexts & Tables

### `identity`
| Table | Columns | Notes |
|-------|---------|-------|
| `users` | id (uuid pk), phone (unique, indexed), spice_tolerance (int, default 3), created_at | |
| `audit_logs` | id, actor_id, action, metadata | EGS 2.3 - immutable audit trail |

### `catalog`
| Table | Columns | Notes |
|-------|---------|-------|
| `restaurants` | id, name, gst_number, fssai_license, commission_rate (decimal, default 0.08), is_active | |
| `menu_items` | id, restaurant_id (fk, indexed), name, price (decimal), dietary_tags (jsonb), customizations (jsonb) | GIN index on `dietary_tags` |

### `ordering`
| Table | Columns | Notes |
|-------|---------|-------|
| `orders` | id, user_id (fk, indexed), restaurant_id (fk, indexed), total_amount (decimal), status (enum), pickup_otp, created_at | 13 SQL states |

### `payments` (stub)
Payment records + Razorpay transaction linkage. To be defined with webhook handling in the payments feature.

### `fulfillment` (stub)
Order status timeline, QR check-in, pickup verification. To be defined with the Live Kitchen Status feature.

## SQL Status Enum (13 states, PRD Section 4)
`DRAFT`, `PAYMENT_PENDING`, `CONFIRMED`, `PREPARING`, `ALMOST_READY`, `READY_FOR_PICKUP`, `PICKED_UP`, `CANCELLED`, `REFUNDED`, `PAYMENT_FAILED`, `EXPIRED`, `DISPUTED`, `SETTLED`.

## RBAC Enum (6 roles)
`CONSUMER`, `VENDOR_OWNER`, `VENDOR_STAFF`, `OPS_AGENT`, `ADMIN`, `SUPER_ADMIN`.

## GIN Index Logic
`dietary_tags` is JSONB. Postgres GIN index enables efficient `@>` containment and `?` key-existence queries, e.g. finding all menu items tagged `{ vegan: true }` at a restaurant. Implemented via Drizzle `index(...).using('gin', sql`(${col} jsonb_path_ops)`)`.

## DDD Boundary Rules (EOS Layer 1.1)
- No direct cross-context DB table reads. Cross-context communication via events only.
- Each schema file declares its context's tables exclusively.
- `packages/db` is the single migration + client boundary; `packages/types` is the single type contract boundary.

## Target Files
- `packages/db/drizzle.config.ts`
- `packages/db/src/schema/identity.ts`
- `packages/db/src/schema/catalog.ts`
- `packages/db/src/schema/ordering.ts`
- `packages/db/src/schema/payments.ts`
- `packages/db/src/schema/fulfillment.ts`
- `packages/db/src/index.ts` (re-exports)
- `packages/types/src/domain.ts`
- `packages/types/src/envelope.ts`
- `packages/types/src/events.ts`
- `packages/types/src/index.ts`

## Verification Criteria (ECS)
- [x] Drizzle config resolves against all schema files (7 tables discovered)
- [x] 13-state SQL enum exported and type-safe
- [x] RBAC enum exported (6 roles)
- [x] GIN index defined on `dietary_tags` (verified in generated SQL)
- [x] Zod envelope schema type-checks
- [x] Event Catalog envelope + 8 core events typed
- [x] `tsc --noEmit` passes for both packages
- [x] Unit tests pass (26/26)

## Evidence
Full machine-readable evidence: `work-logs/phase-1/verification.json`
- Tests: 26/26 PASS
- Coverage (types/src): 95.18% lines
- Migration: `drizzle/0000_demonic_nova.sql` (7 tables, 3 enums, GIN index)
- Typecheck: PASS (db, types)
