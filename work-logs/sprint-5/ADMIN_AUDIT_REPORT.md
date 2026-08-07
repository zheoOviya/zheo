## Admin App (Ops Dashboard) -- Comprehensive Gap Analysis

### Audit Date: Sprint 5 (Pre-Launch)
### Scope: `apps/admin` + `apps/api` admin-relevant endpoints + `packages/db` schema
### PRD Reference: Sections 6 (Risk & Governance), 7 (Kill Switches), EOS Layer 2 (Audit Trail, RBAC)

---

## 1. Executive Summary

The Admin Ops Dashboard (`apps/admin`) is a **minimal skeleton**. It consists of 13 source files total, with only 1 functional page (`/heatmap`). The entire admin surface area is **unauthenticated**, **unprotected by RBAC**, and **lacks every PRD-mandated governance feature**. The API layer has RBAC middleware available (`requireRole`) but it is used on only 2 of 38+ endpoints. The database has an `audit_logs` table receiving writes, but no read endpoint exists to expose audit trails to admins. Kill switches, vendor lifecycle management, user management, and support ticket oversight are all completely absent.

**Criticality: HIGH** -- The platform cannot launch without admin governance controls.

---

## 2. Current State Inventory

### 2.1 Admin Frontend (`apps/admin`)

| Metric | Value |
|--------|-------|
| Total source files | 13 |
| Functional pages | 1 (`/heatmap`) |
| Custom components | 0 (all inline) |
| Auth middleware | **None** |
| Shared UI usage | `@snakzap/ui` listed but unused |
| State management | `zustand` listed but unused |
| API calls | 1 (`GET /api/v1/discovery/heatmap`) |
| Navigation | None (no sidebar, no header, no nav) |

**Routes:**
| Path | Purpose | Auth |
|------|---------|------|
| `/` | Server-side redirect to `/heatmap` | None |
| `/heatmap` | Live Order Heatmap (Mumbai grid, 30s polling) | **None** |
| `404` | Static not-found card | None |
| `error` | Error boundary with "Try Again" | None |

### 2.2 Admin API Surface (`apps/api`)

| Feature | Endpoints | RBAC Protected? |
|---------|-----------|----------------|
| Heatmap | `GET /api/v1/discovery/heatmap` | **No** (public) |
| Chain management | `GET /api/vendor/chains`, `GET /api/vendor/chains/:id/aggregate-insights` | Yes (ADMIN/VENDOR_OWNER) |
| Vendor menu ops | `POST /api/vendor/menu`, `GET /api/vendor/insights`, etc. | **No** (SYS_ACTOR_ID fallback) |
| Vendor settlements | `GET /api/vendor/settlements` | **No** |
| Vendor promotions | `POST /api/vendor/promotions` | **No** |
| Audit logs (read) | **Does not exist** | N/A |
| Kill switches | **Does not exist** | N/A |
| User management | **Does not exist** | N/A |
| Vendor approval/suspend | **Does not exist** | N/A |
| Support ticket oversight | **Does not exist** | N/A |

### 2.3 Database Schema (Admin-Relevant)

| Table | Exists? | Notes |
|-------|---------|-------|
| `users` | Yes | Has `role` enum (6 values: CONSUMER through SUPER_ADMIN). No `is_suspended`, `last_login`, or admin-modifiable fields. |
| `audit_logs` | Yes | Schema: `id`, `actor_id`, `action`, `metadata` (jsonb), `created_at`. Written to but **never read via API**. No FK on `actor_id`. |
| `restaurants` | Yes | Has `is_active` (boolean). No `approval_status`, `suspended_at`, `suspended_reason`, or compliance fields. |
| `kill_switches` | **No** | Does not exist in any migration. |
| `support_tickets` | **No** | Does not exist in any migration. |
| `heatmap` | **No** | Computed on-the-fly from `orders` + `restaurants` join. |

---

## 3. Gap Analysis -- Identified Issues

### A-01: **No Admin Authentication or RBAC Middleware**
- **Category:** Security
- **Severity:** CRITICAL
- **Current:** The entire `apps/admin` is publicly accessible. No `middleware.ts` exists. No login page. No token handling. No role checks. A user browsing to `/heatmap` sees live operational data with zero authentication.
- **PRD Reference:** Section 6 (Risk & Governance) -- "Admin actions require SUPER_ADMIN role." EOS Layer 2 -- "RBAC enforced at middleware level."
- **Acceptance Criteria:**
  1. `apps/admin/middleware.ts` redirects unauthenticated users to a login page.
  2. Login page accepts phone + OTP, validates JWT, and checks `role` claim is `ADMIN` or `SUPER_ADMIN`.
  3. Non-admin users receive 403 Forbidden.
  4. Token stored in `Authorization: Bearer` header for all API calls.

### A-02: **No Admin Layout or Navigation Shell**
- **Category:** UX
- **Severity:** HIGH
- **Current:** `layout.tsx` is a bare `<html><body>` wrapper. No sidebar, no top bar, no navigation breadcrumbs, no sign-out button, no user identity display. Single-page app with no way to reach other admin views.
- **PRD Reference:** Priya (Ops Lead persona) -- needs "dashboard with quick access to live orders, support tickets, and vendor status."
- **Acceptance Criteria:**
  1. Persistent sidebar with links: Dashboard, Orders, Vendors, Support Tickets, Audit Logs, Kill Switches, Heatmap.
  2. Top bar showing admin name/role and sign-out button.
  3. Active route highlighting in sidebar.
  4. Mobile-responsive: collapsible sidebar with hamburger menu.

### A-03: **No Kill Switch Management**
- **Category:** Governance
- **Severity:** CRITICAL
- **Current:** Zero kill switch infrastructure -- no database table, no API endpoint, no UI. The platform cannot be emergency-stopped.
- **PRD Reference:** Section 7 (Kill Switches) -- three triggers:
  1. Vendor Churn > 10% -- auto-suspends onboarding.
  2. CAC > LTV -- blocks paid acquisition, keeps organic.
  3. Webhook Failure > 1% -- auto-routes payments to manual fallback.
- **Acceptance Criteria:**
  1. `kill_switches` DB table with: `id`, `name`, `description`, `enabled` (boolean), `trigger_condition` (jsonb), `auto_trigger` (boolean), `activated_at`, `deactivated_at`, `activated_by`.
  2. `GET /api/v1/admin/kill-switches` -- list all switches with status.
  3. `POST /api/v1/admin/kill-switches/:id/toggle` -- manual toggle (SUPER_ADMIN only).
  4. Admin UI page with toggle switches, status indicators, auto-trigger conditions, and audit history.
  5. At least 3 pre-defined switches: `vendor_churn_protection`, `cac_gtv_protection`, `webhook_fallback`.

### A-04: **No Vendor Lifecycle Management (Approve/Suspend/Onboard)**
- **Category:** Governance
- **Severity:** HIGH
- **Current:** Vendors are created via the vendor app or seed data. The only governance field is `restaurants.is_active`. No approval workflow, suspension UI, or onboarding audit exists.
- **PRD Reference:** Section 6 -- "Admin can approve or suspend vendors." EOS Layer 2 -- "All vendor state changes require audit trail."
- **Acceptance Criteria:**
  1. `GET /api/v1/admin/vendors` -- list all restaurants with status, owner, order count, revenue, commission rate.
  2. `POST /api/v1/admin/vendors/:id/suspend` -- suspend vendor (sets `is_active = false`, writes audit log with reason).
  3. `POST /api/v1/admin/vendors/:id/reactivate` -- reactivate vendor.
  4. `GET /api/v1/admin/vendors/pending` -- list vendors with `is_active = false` (suspended or pending review).
  5. Admin UI: table with vendor rows, search/filter, suspend/reactivate buttons with confirmation dialogs.
  6. Suspension writes to `audit_logs` with action `vendor_suspended` / `vendor_reactivated`.

### A-05: **No Audit Log Viewer**
- **Category:** Compliance
- **Severity:** HIGH
- **Current:** `audit_logs` table receives writes from 3 route files (chains, vendorOps, support). But there is **no read endpoint** to expose audit data. The `findByActor()` and `all()` repository methods are implemented but not wired to any HTTP route.
- **PRD Reference:** EOS Layer 2 -- "Audit trails must be queryable by Admin. Every write path must have a corresponding read path."
- **Acceptance Criteria:**
  1. `GET /api/v1/admin/audit-logs` -- paginated list with filters: `actor_id`, `action`, `date_range`, `search`.
  2. `GET /api/v1/admin/audit-logs/:id` -- single log entry detail.
  3. Admin UI: table with sortable columns, date range picker, action type filter, actor search.
  4. JSON viewer for `metadata` field on detail view.

### A-06: **No User Management (List, Promote, Suspend)**
- **Category:** Operations
- **Severity:** MEDIUM
- **Current:** User roles are set at creation. No admin UI to list users, promote users to roles, or suspend user accounts. The `users` table has no `is_suspended` or `banned_until` column.
- **PRD Reference:** Priya persona -- "Views flagged accounts, manually resets fraud flags."
- **Acceptance Criteria:**
  1. `GET /api/v1/admin/users` -- paginated user list with filters: `role`, `phone`, `created_at` range.
  2. `PUT /api/v1/admin/users/:id/role` -- promote/demote user (SUPER_ADMIN only). Cannot demote self.
  3. Database: add `is_suspended` (boolean, default `false`) and `suspended_reason` (text) to `users` table.
  4. `POST /api/v1/admin/users/:id/suspend` and `POST /api/v1/admin/users/:id/reactivate`.
  5. Admin UI: table with role badges, suspend/reactivate buttons, role dropdown for SUPER_ADMIN.

### A-07: **No Support Ticket Oversight**
- **Category:** Operations
- **Severity:** MEDIUM
- **Current:** Support tickets are created via `POST /api/v1/support/ticket` but there is **no endpoint to list them** and no admin UI to triage. Tickets are stored in-memory (MemoryCatalogRepository style pattern) as they lack a database table.
- **PRD Reference:** Priya persona -- "Sees unresolved tickets, assigns to OPS_AGENT."
- **Acceptance Criteria:**
  1. Database: `support_tickets` table with `id`, `user_id`, `subject`, `description`, `status` (enum: OPEN/IN_PROGRESS/RESOLVED/CLOSED), `priority` (LOW/MEDIUM/HIGH), `assignee`, `created_at`, `updated_at`.
  2. `GET /api/v1/admin/support-tickets` -- paginated list with filters: `status`, `priority`, `assignee`.
  3. `PUT /api/v1/admin/support-tickets/:id` -- update status, assignee, or add internal note.
  4. Admin UI: ticket queue table with priority coloring, status filter tabs, assign dropdown.

### A-08: **No Live Order Dashboard (Ops View)**
- **Category:** Operations
- **Severity:** HIGH
- **Current:** Heatmap exists but shows only geographic density. No list view of active orders with status, restaurant, user, and ETA. No ability to override or cancel orders from admin.
- **PRD Reference:** Priya persona -- "Monitors live orders dashboard, responds to SLA breaches."
- **Acceptance Criteria:**
  1. `GET /api/v1/admin/orders` -- list active orders (non-terminal statuses) with filters: `status`, `restaurant_id`, `date`.
  2. `GET /api/v1/admin/orders/:id` -- order detail with items, payment status, status history, pickup code.
  3. `POST /api/v1/admin/orders/:id/override-status` -- force transition (SUPER_ADMIN only, audit-logged).
  4. Admin UI: real-time order table with auto-refresh, status badges, SLA indicators (time since last transition > threshold), click-through to detail.

### A-09: **No RBAC on Vendor Operations API Routes**
- **Category:** Security
- **Severity:** HIGH
- **Current:** All `/api/vendor/*` routes (menu upload, insights, promotions, settlements, POS sync) use a `SYS_ACTOR_ID` fallback with **zero role checks**. Any authenticated user (including CONSUMER) could in theory call these endpoints if they have a valid JWT.
- **PRD Reference:** EOS Layer 2 -- "RBAC enforced at middleware level for all admin and vendor routes."
- **Acceptance Criteria:**
  1. Apply `requireRole("VENDOR_OWNER", "VENDOR_STAFF", "ADMIN", "SUPER_ADMIN")` to all `/api/vendor/*` endpoints.
  2. Apply `requireRole("ADMIN", "SUPER_ADMIN")` to admin-specific write endpoints (suspend, promote, toggle kill switches).
  3. Audit log every vendor operation with the actual actor's `user_id`, not `SYS_ACTOR_ID`.
  4. Remove `SYS_ACTOR_ID` fallback -- reject unauthenticated requests.

### A-10: **No Key Metrics Dashboard (SLA, Revenue, Churn)**
- **Category:** Operations
- **Severity:** MEDIUM
- **Current:** No dashboard aggregating platform health metrics. No revenue tracking, no SLA monitoring, no vendor churn calculation, no CAC/LTV computation.
- **PRD Reference:** Section 6 -- "Admin sees platform KPIs: daily revenue, active orders, SLA compliance %, vendor churn rate, CAC vs LTV."
- **Acceptance Criteria:**
  1. `GET /api/v1/admin/metrics` -- aggregate payload: `daily_revenue`, `active_orders`, `avg_pickup_time`, `vendor_churn_pct`, `cac_vs_ltv`, `webhook_failure_pct`.
  2. Admin home page: KPI cards with sparkline trends (7-day), color-coded thresholds (green/yellow/red).
  3. Auto-refresh every 60 seconds.
  4. Wired into kill switch auto-trigger evaluation.

### A-11: **No Admin-Specific API Namespace**
- **Category:** Architecture
- **Severity:** MEDIUM
- **Current:** Admin functions are scattered across existing routes (`/api/vendor/`, `/api/v1/discovery/heatmap`) with no dedicated `/api/v1/admin/*` namespace. This makes RBAC enforcement brittle and creates confusion about what endpoints are admin-only.
- **PRD Reference:** Clean architecture pattern -- admin operations should be namespaced under `/api/v1/admin/`.
- **Acceptance Criteria:**
  1. Create `apps/api/src/routes/admin.ts` with router mounted at `/api/v1/admin`.
  2. Migrate admin-specific operations to this router: kill switches, vendor management, user management, audit logs, support tickets, order overrides.
  3. Apply `requireRole("ADMIN", "SUPER_ADMIN")` as default middleware on the router.
  4. Keep read-only endpoints (heatmap, metrics) readable by OPS_AGENT.

---

## 4. Not Done vs Already Done Matrix

| Feature | Status | Where | Notes |
|---------|--------|-------|-------|
| **Heatmap (geographic)** | DONE | `app/heatmap/page.tsx` + `GET /api/v1/discovery/heatmap` | 24x24 Mumbai grid, 30s polling, public. |
| **Order density view** | DONE | Heatmap page | Shows `total_orders` and hot-zone count. |
| **Heatmap data pipeline** | DONE | `DiscoveryService.getHeatmap()` | Aggregates orders from last 30 min, joins restaurants for lat/lng. |
| **Admin login** | NOT DONE | -- | No login page, no middleware, no JWT validation. |
| **Admin layout/nav** | NOT DONE | -- | Bare `<body>` wrapper, no sidebar or chrome. |
| **RBAC on admin app** | NOT DONE | -- | No `middleware.ts`, no role gating. |
| **RBAC on vendor API** | NOT DONE | -- | Only 2/38+ endpoints gated. SYS_ACTOR_ID fallback everywhere. |
| **Kill switches** | NOT DONE | -- | No DB table, no API, no UI. |
| **Vendor approve/suspend** | NOT DONE | -- | Only `is_active` boolean, no workflow. |
| **Audit log viewer** | NOT DONE | -- | Logs written but never readable via API. |
| **User management** | NOT DONE | -- | No user list, role change, or suspend API. |
| **Support ticket oversight** | NOT DONE | -- | No ticket list API, no DB table, no admin UI. |
| **Live order dashboard** | NOT DONE | -- | Only heatmap; no list view or override capability. |
| **Metrics dashboard** | NOT DONE | -- | No KPI aggregation API or UI. |
| **Admin API namespace** | NOT DONE | -- | No `/api/v1/admin/*` router exists. |
| **Order status override** | NOT DONE | -- | No force-transition endpoint. |
| **Platform config management** | NOT DONE | -- | Commission rates, fee structures hardcoded. |
| **Fraud flag review** | NOT DONE | -- | No fraud detection pipeline or admin review UI. |

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Unauthorized access to ops data | **Certain** (no auth) | HIGH -- exposes live orders, restaurant data | A-01, A-09 |
| No emergency stop capability | **Certain** (no kill switches) | CRITICAL -- cannot halt platform during incident | A-03 |
| Vendor compliance unenforceable | **Certain** (no lifecycle mgmt) | HIGH -- fraudulent vendors cannot be suspended | A-04 |
| Security incidents untraceable | **Certain** (no audit read path) | HIGH -- cannot investigate who did what | A-05 |
| Support tickets unmanaged | **Certain** (no list/db table) | MEDIUM -- customer issues invisible to ops | A-07 |
| Vendor ops endpoints exposed | **Certain** (no RBAC) | HIGH -- consumers could access vendor tools | A-09 |

---

## 6. Recommended Implementation Priority

| Phase | Issues | Effort | Rationale |
|-------|--------|--------|-----------|
| **Phase 1 (Must: Launch Blocker)** | A-01, A-03, A-09, A-11 | ~8 story points | Auth + RBAC + kill switches + namespace. Cannot launch without these. |
| **Phase 2 (Should: Week 1)** | A-02, A-04, A-05, A-08 | ~10 story points | Layout/nav + vendor mgmt + audit viewer + order dashboard. Ops persona blocked without these. |
| **Phase 3 (Could: Week 2-3)** | A-06, A-07, A-10 | ~8 story points | User mgmt + support tickets + metrics. Completes Priya persona. |

**Total: 11 identified issues (A-01 through A-11). 26 estimated story points.**
