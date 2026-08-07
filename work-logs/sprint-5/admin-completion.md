# Sprint 5.2 - Admin Completion (User Mgmt & Support Tickets)

**Date:** 2026-08-07
**Status:** In Progress
**Phase:** Sprint 5 (Admin Ops & Governance) - Feature Completion

## Overview

Sprint 5.1 closed critical security/persistence gaps. Sprint 5.2 completes the remaining medium-priority admin features: User Management (A-06) and Support Ticket Oversight (A-07). Also finalizes the Admin Sidebar navigation (A-02).

## Task 1: User Management (A-06)

### Schema
- Add `is_suspended BOOLEAN DEFAULT false` to `users` table
- Add to `IdentityUser` interface

### Repository
- `IdentityRepository.listAll(page, limit, searchPhone)`: paginated user listing
- `IdentityRepository.suspend(userId)`: set is_suspended=true
- `IdentityRepository.reactivate(userId)`: set is_suspended=false

### API Endpoints (adminWrite / adminReadOnly)
- `GET /api/v1/admin/users` -- paginated, searchable by phone
- `PUT /api/v1/admin/users/:id/suspend` -- audit-logged
- `PUT /api/v1/admin/users/:id/reactivate` -- audit-logged

### UI
- `/users` page: table with phone, role, suspension status, created date, suspend/reactivate button

## Task 2: Support Ticket Oversight (A-07)

### Schema
- `support_tickets` table: id(UUID), user_id(UUID FK), subject(TEXT), description(TEXT), priority(ENUM: LOW/MEDIUM/HIGH), status(ENUM: OPEN/IN_PROGRESS/RESOLVED/CLOSED), assigned_to(TEXT), created_at(TIMESTAMPTZ), updated_at(TIMESTAMPTZ)

### Repository
- Extend `SupportRepository` with `listAll()`, `updateStatus()`, `updateAssignee()`

### API Endpoints (adminReadOnly / adminWrite)
- `GET /api/v1/admin/support-tickets` -- filterable by status/priority
- `PUT /api/v1/admin/support-tickets/:id` -- update status and/or assignee
- `GET /api/v1/admin/support-tickets/:id` -- single ticket detail

### UI
- `/support-tickets` page: filterable table with subject, priority badge, status badge, assignee, created date

## Task 3: Admin Navigation (A-02)
- Add "Users" and "Support Tickets" links to Sidebar component

## Files Changed

| File | Action |
|------|--------|
| `work-logs/sprint-5/admin-completion.md` | CREATE |
| `packages/db/src/schema/identity.ts` | MODIFY (is_suspended) |
| `packages/db/src/schema/supporttickets.ts` | CREATE |
| `packages/db/src/schema/index.ts` | MODIFY (export) |
| `packages/db/index.ts` | MODIFY (export) |
| `apps/api/src/repositories/identityRepository.ts` | MODIFY (listAll, suspend, reactivate) |
| `apps/api/src/repositories/supportRepository.ts` | MODIFY (listAll, updateStatus/Assignee) |
| `apps/api/src/routes/admin.ts` | MODIFY (users + support-tickets endpoints) |
| `apps/admin/components/Sidebar.tsx` | MODIFY (add Users, Support Tickets links) |
| `apps/admin/app/(admin)/users/page.tsx` | CREATE |
| `apps/admin/app/(admin)/support-tickets/page.tsx` | CREATE |
| `apps/admin/lib/api.ts` | MODIFY (add user + ticket functions) |
| `apps/api/src/routes/admin.test.ts` | MODIFY (user + ticket tests) |
| `work-logs/sprint-5/verification.json` | MODIFY |
