## Sprint 5 -- Admin Ops & Governance (Launch Blockers)

### Goal
Secure the admin surface area, enforce RBAC across all vendor routes, implement kill switches from PRD Section 7, expose audit logs, and build the ops dashboard Priya needs.

### Tasks

- **[A-01, A-09, A-11]** Admin Auth & API Namespace -- Login page, middleware, `/api/v1/admin/*` router, RBAC on vendor routes
- **[A-02, A-08]** Admin Layout & Live Orders -- Sidebar, dashboard with order status counts + live table
- **[A-03]** Kill Switches -- DB table, 3 business switches, API, Admin UI page
- **[A-05, A-04]** Audit Log Viewer & Vendor Lifecycle -- Paginated audit API, vendor suspend/reactivate API, Admin UI pages
