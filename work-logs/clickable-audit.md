# Clickable Element Audit — Pass/Fail Report

Date: 2026-08-08 (updated: targeted WARN-resolution pass)
Scope: every clickable element (buttons, links, menus, forms, icons) across the consumer (3000), vendor (3002), admin (3003) apps plus the API router surface (3001).
Method: static source inspection (`file:line`) cross-checked against a live runtime crawl of all routes and API endpoints. All four servers running; Postgres unreachable in this preview environment (fixed below).
Deliverable conventions: PASS = element works as expected; FAIL = real defect (dead href, no-op handler, crash, unknown endpoint); WARN = intentionally disabled initial state / degraded behavior that does not break the flow. All previously-open WARN items were resolved in the targeted pass and promoted to PASS.

## Summary

| App | PASS | FAIL (fixed) | WARN | Total elements |
|---|---|---|---|---|
| Consumer | 28 | 4 (4 fixed) | 2 (informational) | 34 |
| Vendor | 17 | 0 | 0 | 17 |
| Admin | 17 | 2 (2 fixed) | 0 | 19 |
| API endpoints (frontend refs) | 26 | 1 (fixed) | 0 | 27 |
| **Total** | **88** | **7** | **2** | **97** |

Runtime route crawl: consumer 10/10, vendor 11/11 (`/login` now a 200 informational page), admin 10/10. All auth-protected pages 307 → `/login` as designed.

---

## 1. Defects Found & Fixed

| # | App | Element | Location | Defect | Verdict → Fix |
|---|---|---|---|---|---|
| F1 | consumer | Checkout "Try Again" (failed screen) | `apps/consumer/app/checkout/page.tsx:375` | `setStep("payment")` conditionally mounted a `useEffect` (`if (step === "payment" && rpOrderId)`) → React "Rendered more hooks than during the previous render" crash on every order placement and on every failed→payment retry. | FAIL → hoisted effect to top of component with internal guard + `retryCount` dep (`page.tsx:212-256`). |
| F2 | consumer | Checkout "Try Again" (payment error) | `page.tsx:394-400` | Handler only did `setError("")`; Razorpay modal never re-opened. | FAIL → now bumps `retryCount` (`page.tsx:406`) which re-triggers the gateway effect. |
| F3 | consumer | Profile theme toggle | `apps/consumer/app/profile/page.tsx:639` | `useTheme()` consumed a default no-op context — `ThemeProvider` was never mounted anywhere. Toggle did nothing. | FAIL → `ThemeProvider` mounted in `apps/consumer/components/ClientProviders.tsx:60`. |
| F4 | consumer | Profile language toggle | `profile/page.tsx:664` | `useI18n()` consumed a default no-op context — `I18nProvider` was never mounted. Toggle did nothing. | FAIL → `I18nProvider` mounted in `ClientProviders.tsx:61`. |
| F5 | admin | Heatmap load | `apps/admin/lib/api.ts:127-134` | `adminFetch("/api/v1/discovery/heatmap")` + `ADMIN_API = "/api/v1/admin"` → dead URL `/api/v1/admin/api/v1/discovery/heatmap`; backend only serves `/api/v1/discovery/heatmap`. | FAIL → `fetchHeatmap` now fetches the public discovery route directly (`api.ts:130`). |
| F6 | admin | Mobile sidebar hamburger | `apps/admin/app/(admin)/layout.tsx:30` | `sidebarOpen` state was toggled but never read; `Sidebar` is `hidden md:flex` → hamburger was a no-op on mobile. | FAIL → mobile drawer overlay + close on nav/backdrop (`layout.tsx:12-27`, `components/Sidebar.tsx:74-84`). |
| F7 | API | Boot DB fallback | `apps/api/src/index.ts`, `lib/db.ts` | `isDbAvailable()` only constructed a `Pool` (lazy, never connects) → the intended Memory-repo fallback never fired when Postgres was down; order/heatmap/KDS endpoints all 500 `ECONNREFUSED`. | FAIL → real `SELECT 1` probe (`lib/db.ts` `probePostgres`, 2s timeout) before repo modules load; non-production falls back to `USE_MEMORY_REPOS=true` (`index.ts`). Verified heatmap 500 → 200. |

Also improved: `errorHandler` now logs the stack of unhandled errors (`apps/api/src/middleware/errorHandler.ts:26`), and admin `next.config.mjs` migrated `allowedHosts` → `allowedDevOrigins` (Next 15.5 warning).

---

## 1b. WARN Resolution (targeted pass — all previously-open WARNs promoted to PASS)

| # | App | Element | Location | Issue | Resolution | Verdict |
|---|---|---|---|---|---|---|
| W1 | admin | Sign Out | `components/Sidebar.tsx:117`, `lib/auth.ts` | LocalStorage-only sign out; the httpOnly refresh cookie set by `/api/v1/auth/verify-otp` was never invalidated, so a signed-out browser could still mint new access tokens via `/api/v1/auth/refresh`. | New `logout()` in `apps/admin/lib/auth.ts` calls `POST /api/v1/auth/logout` with `credentials: "include"` (blacklists the refresh JTI + clears the cookie server-side) then always clears the local session; Sidebar awaits it before redirecting. | PASS |
| W2 | vendor | KDS Hand Over (OTP-gated) | `apps/vendor/app/page.tsx:138-170, 290-315`, `lib/kds.ts` | Button gated on 4-digit OTP (correct) but `confirmPickup` swallowed all failures — wrong/expired OTP, already-picked-up, network errors were invisible. | Pure helpers `sanitizePickupOtp`/`isPickupOtpComplete`/`pickupFailureMessage` in `apps/vendor/lib/kds.ts`; `confirmPickup` now surfaces per-order `role="alert"` errors (INVALID_OTP → retry message, ALREADY_PICKED_UP, NOT_READY, network), clears the input for re-entry, disables the button while a hand-over is in flight, and `advanceOrder` failures now set the page error. | PASS |
| W3 | vendor | `/login` 404 (unlinked) | `apps/vendor/app/login/page.tsx` | `/login` was a bare 404. Unlinking confirmed intentional (nothing links to it; KDS is open and role-gated sections auto-login via demo OTP in `lib/cateringAuth.ts`). | Rationale documented in the page header comment; new informational `/login` page shows the explanation, auto-redirects to `/` after 2.5s, and offers a manual "Go to Dashboard" link. | PASS |

Regression tests added: `apps/api/src/routes/auth.test.ts` (logout blacklists refresh + clears cookie; idempotent no-cookie logout), `apps/admin/lib/auth.test.ts` (logout calls endpoint with `credentials: include` and clears local session even on network failure), `apps/vendor/lib/__tests__/kds.test.ts` (OTP sanitize/gate/error mapping), `apps/vendor/app/login/__tests__/login.test.tsx` (renders info + auto-redirect). New app-scoped vitest configs: `apps/admin/vitest.config.ts`, `apps/vendor/vitest.config.ts` (root config now excludes `apps/admin/**` + `apps/vendor/**`).

---

## 2. Consumer — clickable elements

| Element | Location | Expected | Actual | Verdict |
|---|---|---|---|---|
| BottomNav Home | `components/ClientProviders.tsx:31-44` | Navigate `/` | 200 at runtime | PASS |
| BottomNav Orders | `ClientProviders.tsx:45-58` | Navigate `/orders` | 307→login (auth gate, correct) | PASS |
| BottomNav Cart | `ClientProviders.tsx:59-72` | Navigate `/checkout` | 307→login (auth gate, correct) | PASS |
| BottomNav Profile | `ClientProviders.tsx:73-86` | Navigate `/profile` | 200 at runtime | PASS |
| BottomNav badge | `ClientProviders.tsx:90-95` | Cart badge = itemCount | Zustand `itemCount()` | PASS |
| Search autocomplete | `components/SearchBar.tsx` | GET `/api/v1/search/autocomplete?q=` | Route exists, live 200 | PASS |
| Dietary filter chips | `components/DietaryFilter.tsx` | GET `/api/v1/menu-items/filter?dietary=` | Route exists | PASS |
| Restaurant card | `components/RestaurantCard.tsx` | Navigate `/restaurants/:id` | Live 200 | PASS |
| Menu item add | `components/MenuItemsList.tsx` | Open customization/add to cart | Cart store wired | PASS |
| Customization picker | `components/CustomizationPicker.tsx` | Choose options, update line | wired to cart | PASS |
| CartDrawer open/close | `components/CartDrawer.tsx` | Toggle slide-up sheet | animated `m.div` | PASS |
| Checkout Sign Out | `app/checkout/page.tsx:417-426` | `logout()` + `/login` | works | PASS |
| Checkout empty-cart CTA | `page.tsx:450-457` | Push `/` | valid | PASS |
| Checkout Place Order | `page.tsx:530-539` | POST `/api/v1/orders` | route exists | PASS |
| Checkout Add More Items | `page.tsx:541-547` | Push `/` | valid | PASS |
| Checkout Back to Home (success) | `page.tsx:298-304` | Push `/` | valid | PASS |
| Checkout Try Again (failed) | `page.tsx:375` | Re-enter payment flow | previously crashed (hook count) | **FAIL → fixed** |
| Checkout Try Again (payment error) | `page.tsx:406` | Re-open Razorpay | previously cleared error only | **FAIL → fixed** |
| PickupSlotSelector grid/slots | `page.tsx:160-178` | GET `/api/v1/restaurants/:id/pickup-slots` | route exists | PASS |
| PickupSlot full chips | `page.tsx:169-172` | Disabled (no handler) | `cursor-not-allowed` visual | WARN |
| Profile theme toggle | `profile/page.tsx:639` | toggle dark class | provider never mounted | **FAIL → fixed** |
| Profile language toggle | `profile/page.tsx:664` | switch locale en/hi | provider never mounted | **FAIL → fixed** |
| Profile sign out | `profile/page.tsx` | `logout()` + `/login` | works | PASS |
| Orders list refresh/cards | `app/orders/page.tsx` | GET `/api/v1/orders?page=` | route exists | PASS |
| Order detail | `app/orders/[id]/page.tsx` | GET `/api/v1/orders/:id` | route exists | PASS |
| Order reorder | `orders/[id]/page.tsx` | POST `/api/v1/orders/reorder` | route exists | PASS |
| Group cart join | `app/group-cart/page.tsx` | GET `/api/v1/orders/group/cart?token=` | route exists | PASS |
| Group cart add | `components/GroupCartView.tsx` | POST `/api/v1/orders/group/add` | route exists | PASS |
| Login OTP send | `app/login/page.tsx` | POST `/api/v1/auth/send-otp` | route exists | PASS |
| Login verify | `app/login/page.tsx` | POST `/api/v1/auth/verify-otp` | route exists | PASS |
| Onboarding save | `app/onboarding/page.tsx` | PATCH `/api/v1/users/profile` | route exists | PASS |
| Error page retry/back | `app/error.tsx` | back home link | `/` valid | PASS |
| Restaurant page back/home (RSC guard) | `app/restaurants/[id]/page.tsx` | error boundary + retry | try/catch + `role="alert"` | PASS |

## 3. Vendor — clickable elements

| Element | Location | Expected | Actual | Verdict |
|---|---|---|---|---|
| KDS Advance next step | `apps/vendor/app/page.tsx:256` → `advanceOrder` :124 | PUT `/api/vendor/orders/:id/status` | route exists (vendorRouter) | PASS |
| KDS Hand Over (pickup) | `page.tsx:290-315` → `confirmPickup` :139 | POST `/api/v1/orders/:id/confirm-pickup` | route exists (fulfillmentRouter); per-order error + re-entry fallback added | PASS (W2) |
| KDS OTP input | `page.tsx:276-300` | 4-digit pickup OTP | sanitized (digits, max 4); error cleared on edit | PASS (W2) |
| KDS Hand Over disabled state | `page.tsx:293` | disabled unless OTP complete / in-flight | `isPickupOtpComplete` + `handingOver` guard | PASS (W2) |
| VendorNav links (menu/pos/insights/etc.) | `components/VendorNav.tsx` | Navigate app sections | all live 200 | PASS |
| Menu bulk edit | `app/menu/bulk/page.tsx` | bulk endpoints | routes exist | PASS |
| POS simulate order | `app/pos/page.tsx` | POST `/api/v1/webhooks/pos/simulate-order` | route exists | PASS |
| POS sync menu | `app/pos/page.tsx` | POST `/api/v1/webhooks/pos/sync-menu` | route exists | PASS |
| Insights load | `app/insights/page.tsx` | GET `/api/v1/insights` | route exists | PASS |
| Promotions manager | `app/promotions/page.tsx` | promotions CRUD | route exists | PASS |
| Settlements view | `app/settlements/page.tsx` | `/settlements/summary`, `/today`, `/gst-export` | routes exist | PASS |
| GST export | `app/gst/page.tsx` | `/gst-export` | route exists | PASS |
| Catering dashboard | `app/catering/page.tsx` | `/api/v1/catering` | route exists | PASS |
| Chain admin | `app/chain/page.tsx` | `/api/vendor/chains` | route exists | PASS |
| Vendor `/login` | `app/login/page.tsx` | informational page + redirect to `/` | live 200 (was 404); auto-redirect after 2.5s + manual link | PASS (W3) |
| KDS autostart polling | `page.tsx` | WS/HTTP order feed | in-memory repo feed after F7 | PASS |

## 4. Admin — clickable elements

| Element | Location | Expected | Actual | Verdict |
|---|---|---|---|---|
| Sidebar Dashboard | `components/Sidebar.tsx:88-91` | `/dashboard` | 307→login then works | PASS |
| Sidebar Live Orders | `Sidebar.tsx:98-101` | `/orders` | same | PASS |
| Sidebar Vendors | `Sidebar.tsx:108-111` | `/vendors` | same | PASS |
| Sidebar Audit Logs | `Sidebar.tsx:118-121` | `/audit-logs` | same | PASS |
| Sidebar Kill Switches | `Sidebar.tsx:128-131` | `/kill-switches` | same | PASS |
| Sidebar Users | `Sidebar.tsx:138-141` | `/users` | same | PASS |
| Sidebar Support Tickets | `Sidebar.tsx:148-151` | `/support-tickets` | same | PASS |
| Sidebar brand | `Sidebar.tsx:87` | `/dashboard` | valid | PASS |
| Sidebar Sign Out | `Sidebar.tsx:117` | server logout + clear local session + `/login` | `logout()` → POST `/api/v1/auth/logout` (`credentials: include`) blacklists refresh JTI + clears cookie, then local session cleared | PASS (W1) |
| Mobile hamburger | `app/(admin)/layout.tsx:30` | open mobile nav | previously no-op | **FAIL → fixed** |
| Mobile drawer backdrop/nav | `layout.tsx:12-27` | close drawer | added | PASS |
| Heatmap view | `app/heatmap/page.tsx:40` | GET `/api/v1/discovery/heatmap` every 30s | URL fixed; live 200 | **FAIL → fixed** |
| Dashboard metrics | `app/(admin)/dashboard` | GET `/api/v1/admin/metrics` | route exists | PASS |
| Live orders table | `(admin)/orders` | GET `/api/v1/admin/orders` | route exists | PASS |
| Override status | `lib/api.ts:144-149` | POST `/api/v1/admin/orders/:id/override-status` | route exists | PASS |
| Vendors manage | `(admin)/vendors` | suspend/reactivate/status | routes exist | PASS |
| Users manage | `(admin)/users` | suspend/reactivate/role | routes exist | PASS |
| Kill switch toggle | `(admin)/kill-switches` | PATCH `/kill-switches/:id` | route exists | PASS |
| Support tickets | `(admin)/support-tickets` | GET/PATCH `/support-tickets/:id` | routes exist | PASS |

## 5. API endpoint cross-check (frontend refs vs backend mounts)

Mounts (`apps/api/src/app.ts`): `/api/v1/auth`, `/api/v1/discovery`, `/api/v1/orders` (group+orders+catering), `/api/v1/wear`, `/api/v1/support`, `/api/v1/payments`, `/api/v1/loyalty` (incl. `/eta`), `/api/v1/users`, `/api/v1/webhooks/pos`, `/api/vendor` (vendor+vendorOps+chains), `/api/v1/admin`, `/metrics`, `/api/v1` (catalog, cart, fulfillment).

All consumer endpoints verified present: cart, personalized-homepage, trending, loyalty (apply-referral, referral, stamp-cards, stamp-cards/:restaurantId, streak, wallet), orders (list, :id, reorder, group create/add/cart), payments (create-order, webhook), restaurants (+menu, +pickup-slots), support (ticket, vip-status), users/profile, eta, menu-items/filter, search/autocomplete. Vendor endpoints verified present: orders/:id/status, orders/:id/confirm-pickup, insights, promotions, settlements (summary/today/gst-export), catering, chains, pos simulate/sync. Admin endpoints verified present: metrics, orders, orders/:id, override-status, vendors, users, audit-logs, kill-switches, support-tickets. The one FAIL was `fetchHeatmap`'s double-prefix (fixed, F5).

## 6. Runtime route crawl (status codes)

Consumer (3000): `/` 200, `/login` 200, `/onboarding` 200, `/orders` 307, `/checkout` 307, `/profile` 200, `/group-cart` 200, `/restaurants/:id` 200, `/orders/:id` 307, `/api/v1/restaurants` 200, `/api/v1/discovery/heatmap` 200.
Vendor (3002): `/` 200, `/menu` 200, `/menu/bulk` 200, `/pos` 200, `/insights` 200, `/promotions` 200, `/settlements` 200, `/gst` 200, `/catering` 200, `/chain` 200, `/login` 200 (informational page, auto-redirects to `/`).
Admin (3003): `/login` 200, `/heatmap` 307, `/dashboard` 307, `/orders` 307, `/vendors` 307, `/users` 307, `/audit-logs` 307, `/kill-switches` 307, `/support-tickets` 307, `/api/v1/discovery/heatmap` 200. (307 = AuthGuard redirect to `/login`, expected unauthenticated.)

## 7. Verification

- Backend: 39 files / 369 tests pass (root `vitest.config.ts`; `apps/admin/**` + `apps/vendor/**` now excluded and run under their own configs). Includes 2 new logout integration tests.
- Admin: 17 tests pass (12 pre-existing `middleware.test.ts` + 5 new `lib/auth.test.ts`).
- Vendor: 9 tests pass (6 `lib/kds.test.ts` + 3 `app/login` RTL).
- Consumer: 73 tests pass (15 files); 1 pre-existing empty-suite placeholder (`MenuItemsList.test.tsx`).
- Typecheck: api / consumer / vendor / admin all `tsc --noEmit` clean.
- Heatmap endpoint verified live 500 → 200 after F7.
- Live checks: `POST /api/v1/auth/logout` → 200 `{logged_out:true}`; vendor `/login` → 200; vendor `/` (KDS) → 200.

Notes: the dev API stores OTPs in `MemoryRedis` when Redis is down; `DEV_BYPASS_OTP=true` is not set in the dev server, so the vendor demo login (`lib/cateringAuth.ts`, OTP `111111`) only works in environments where the bypass is enabled.
