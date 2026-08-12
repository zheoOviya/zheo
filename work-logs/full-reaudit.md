# Full Project Re-Audit — 2026-08-09

**Scope:** All 4 apps (api/consumer/vendor/admin) + shared packages (ui/config/db/types) across 6 dimensions: clickable elements, runtime errors, UI alignment, security hardening, DevOps tooling, code quality. Four parallel sub-audits + independent code-level verification of every confirmed defect.

**Baseline:** All fixes from the previous session (admin logout, KDS OTP, vendor `/login`) were re-verified intact.

---

## 1. Verdict Matrix (PASS / FAIL / WARN per category)

| Dimension | api | consumer | vendor | admin | packages/ui | CI impact |
|---|---|---|---|---|---|---|
| Clickable elements | PASS | PASS | PASS | PASS | PASS | — |
| Runtime errors | — | PASS (WARNs fixed) | PASS (motion fixed) | PASS (FAIL fixed) | PASS | — |
| UI alignment | — | PASS | PASS | WARN | WARN | — |
| Security | PASS (2 FAILs fixed) | PASS | WARN | WARN | — | — |
| DevOps tooling | PASS (2 FAILs fixed) | — | — | — | — | now CI-safe |
| Code quality | WARN | WARN | WARN | WARN | WARN | — |

**Overall: all FAILs resolved this session; 0 failing tests, 0 typecheck errors, 0 lint errors.**

---

## 2. Clickable Elements — PASS

Prior clickable audit closed W1 (admin Sign Out), W2 (KDS Hand Over/OTP), W3 (vendor `/login`) → all PASS. Re-audit found no new clickable FAILs. All links/buttons/forms wired to existing routes (consumer 11/11, vendor 11/11, admin 10/10, verified live 200s for heatmap, logout, vendor `/login`).

## 3. Runtime Errors

### Fixed this session
- **FAIL (admin):** `apps/admin/app/(admin)/orders/page.tsx` — `showDetail()` set `loadingDetail=true` and never reset it → expanded order row stayed on the skeleton forever. Removed dead `loadOrderDetail`, added `finally { setLoadingDetail(false) }`, and keyed the `.map` fragment (`<Fragment key={o.id}>`) to kill the React key warning. Regression: `orders.test.tsx` (3 tests) — expands → shows detail, toggles → collapses.
- **WARN-high (consumer):** `AuthGate.tsx` — `refreshAccessToken().then()` had no `.catch`; a network failure left the user on an infinite "Verifying session…" spinner. Added `.catch(() => router.replace("/login"))`.
- **WARN (consumer):** `app/profile/page.tsx` `Promise.all` ran in `try/finally` with no catch → unhandled rejection + silent empty skeletons. Added `catch` that surfaces a `role="alert"` banner.
- **WARN (vendor motion):** KDS `m.div layout` + `AnimatePresence mode="popLayout"` under `LazyMotion features={domAnimation}`. Verified in framer-motion 13.0.0 source (`motion/index.mjs` `getProjectionFunctionality` returns `{}` when `layout`/`drag` features are absent) — the `layout` prop was a **silent no-op** (cards snapped instead of animating; `popLayout` degraded). **Fix (motion import correction):** `VendorLayoutClient.tsx` now imports `domMax` (the bundle that registers the `layout` feature) instead of `domAnimation`.

### Open WARNs (documented, not blocking)
- `res.json()` without `res.ok` check across consumer/vendor/admin fetchers (5xx HTML/empty body → SyntaxError). Suggested shared helper below (§7).
- vendor `cateringAuth.ts` caches the demo token forever (no refresh → 401 mid-session); `send-otp` response unchecked.
- Zustand whole-store destructuring in 6 components (perf churn, no correctness bug).
- `FeatureFlagProvider` builds a fresh `flags` object per render (unused in app).
- `packages/ui/Sheet.tsx` rAF not cancelled; `CountdownTimer` `onExpire` in deps.

**Clean (verified):** no conditional hooks anywhere; every interval/WS/event effect has cleanup; zero `motion.X` components outside LazyMotion; `localStorage` all SSR-guarded; consumer/group-cart/checkout store logic correct.

## 4. UI Alignment — PASS with WARNs

### Verified compliant (sprint-10 tokens)
- `Container` owns global rhythm; consumer pages use `py-*` only; narrow pages (`max-w-2xl/3xl`) keep `mx-auto` and drop `px` (double-gutter PASS).
- Typography: no `text-[Npx]` arbitrary sizes anywhere; `text-2xs` token used consistently.
- Grids: consumer `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`; KDS `grid-cols-2 md:grid-cols-3 xl:grid-cols-4` both present.
- Safe areas: `pb-safe` etc. defined + applied (BottomNav, Sheet, CartDrawer). Button md/lg `min-h-[44px]`; KDS actions 44px.

### WARNs with code-level fixes (see §7)
1. Full-screen consumer pages re-apply `px-4` inside Container (login/onboarding/not-found/error) → double gutter.
2. Admin has **zero** `@snakzap/ui` Container adoption; heatmap hand-rolls `mx-auto max-w-5xl p-8`, `h-[540px]`, `rounded-[3px]`.
3. <44px touch targets: consumer profile theme-toggle (`p-2`), RestaurantCard Quick Add / "+ Add", admin sidebar toggle + support-tickets/audit-logs text-xs buttons.
4. `space-2xs..2xl` tokens adopted only 2× (dead vocabulary).
5. Admin `globals.css` lacks `pb-safe`/`min-h-touch` utilities.
6. packages/ui Button/Card/BottomNav are CSS-only (`active:scale`, hover) — sprint-8 spec wanted framer variants; either adopt `m.` under existing LazyMotion or keep CSS (works, just deviates).

## 5. Security Hardening

### Fixed this session
- **FAIL (OTP timing):** `services/otp.ts` compared OTPs with `!==`. Now constant-time (`timingSafeEqual` over equal-length buffers). Same fix applied to the 4-digit **pickup OTP** compare in `services/fulfillment.ts` (`safeEqual`).
- **FAIL (OTP bypass):** `DEV_BYPASS_OTP === "true"` accepted any 6-digit OTP with **no environment guard** — exploitable if the flag leaked to production. Now gated on `process.env.NODE_ENV !== "production"`.
- **HIGH (pickup brute-force):** `POST /api/v1/orders/:id/confirm-pickup` has a 4-digit OTP (10k space) with no route-level protection. Added fail-closed `pickupLimiter` (10/min per `orderId|ip`, 429/503) in `routes/fulfillment.ts`. Note: ownership binding to `order.user_id` was deliberately **not** added — the vendor KDS hand-over drives this endpoint and the OTP is intentionally shared with the vendor; the limiter closes the brute-force window instead (design tradeoff documented).

### Verified intact (sprint-6/7/8 claims)
- JWT `algorithms: ["HS256"]` + issuer on verify; refresh cookie httpOnly/secure/sameSite=strict; jti blacklist + server-side logout on all three apps; admin logout calls backend (previous session).
- CORS explicit allowlist (no `origin:true`); helmet on; body limit 1mb; zod validation everywhere; no raw SQL (Drizzle only); image MIME/size/extension sanitization; no `dangerouslySetInnerHTML` anywhere.
- Rate limiter fail-closed on OTP/auth/payments/admin-write (sprint-6), now + pickup.
- `otpLimiter` 3/min phone-keyed fail-closed on send + verify OTP (sprint-7).

### Open WARNs (documented)
- WARN: WebSocket subscribe (`lib/websocket.ts`) is unauthenticated (status updates for arbitrary order/restaurant ids). Medium.
- WARN: admin access JWT in `localStorage` (XSS-exposed) — mitigated by Bearer-header usage + no `dangerouslySetInnerHTML`; considered a known tradeoff.
- WARN: razorpay/petpooja MOCK_MODE activates when keys are empty (no `NODE_ENV` guard) — same class of issue as the OTP bypass just fixed.
- WARN: CORS allowlist doesn't include `*.monkeycode-ai.live` (frontends work via same-origin `/api` rewrites, so only affects direct cross-origin calls).
- INFO: no password auth in system (OTP-only), so bcrypt/lockout N/A; OTP limiter is the lockout proxy.

## 6. DevOps Tooling

### Fixed this session
- **FAIL (fake health probe):** `/health` "checked" Postgres by calling `getDb()` — a lazy pool constructor that never opens a socket, and a PG failure did **not** flip `healthy=false` (always 200). Now issues a real `probePostgres(1500)` (`SELECT 1`) when Postgres is actually in use; test mode → `postgres: "test"`, memory-repo boot → `postgres: "memory"` (keeps dev/preview 200). PG down in a real-DB deployment now degrades to 503.
- **FAIL (lint stack):** `next lint` is **deprecated** in Next 15.5.22 (removed in 16); the Next ESLint plugin was never registered (only `@typescript-eslint`); `.eslintrc.cjs` was dead under flat config. Fixed: all 3 Next apps now run `eslint .`; `eslint.config.mjs` registers `@next/eslint-plugin-next` (recommended + core-web-vitals rules); generated files (`**/.next/**`, `next-env.d.ts`) ignored. Result: 0 lint errors repo-wide (warnings only). `.eslintrc.cjs`/`.eslintignore` left in place (inert — removal left to a cleanup PR).
- **FAIL (frontend tests not in CI):** root `pnpm test` only ran API + packages; consumer/vendor/admin suites were never CI-gated. `ci.yml` now runs all three per-app suites.
- **WARN→done (empty suite):** `consumer/components/MenuItemsList.test.tsx` was a 1-line stub → vitest failed collection ("No test suite found"), which would have red'd the new CI step. Replaced with 2 real RTL tests.
- **Tooling:** `prettier` installed + `format`/`format:check` scripts added.

### Open WARNs (documented)
- No coverage gate (`@vitest/coverage-v8` installed but unused), no Next `build` in CI, no env validation/fail-fast at API boot (JWT secrets only log a warning, don't exit), `.env.production`/`.env.test` not in `.gitignore`, `.env.example` incomplete (PETPOOJA_*/S3_*/CORS_ORIGINS/DEV_BYPASS_OTP undocumented; `GOOGLE_MAPS_API_KEY` name mismatch with documented `NEXT_PUBLIC_MAPS_API_KEY`), README test counts stale (says 386/45; actual 372/39 root + 75 consumer + 9 vendor + 20 admin).
- `pnpm format:check` currently reports 209 files out of style (repo was never prettier-formatted) → run one-time `pnpm format` before gating.
- No pre-commit hooks (husky/lint-staged absent).
- Graceful shutdown solid (SIGTERM/SIGINT, 10s force-exit); minor: no SIGQUIT, no `closeIdleConnections()`, unhandledRejection/uncaughtException log but don't exit, WS server not explicitly closed.

## 7. Suggested fixes with code-level detail (not yet implemented)

### 7.1 Tailwind token / Container
```tsx
// consumer/app/login/page.tsx + onboarding/page.tsx + not-found + error
// Full-screen pages: render the full-bleed <main> OUTSIDE the layout Container,
// or use <Container maxWidth="full" className="min-h-screen flex items-center">.
// Do NOT re-apply px-4 (the layout Container already adds the gutter).

// admin heatmap (apps/admin/app/(admin)/heatmap/page.tsx)
import { Container } from "@snakzap/ui";
<Container maxWidth="5xl" className="py-8">  // replaces mx-auto max-w-5xl p-8
  // map: h-[540px] -> h-[35rem]; rounded-[3px] -> rounded-sm
</Container>
```
### 7.2 Touch targets (Apple 44dp)
```tsx
// consumer/app/profile/page.tsx:641 theme toggle
<button className="p-2 ..." />  ->  <button className="min-h-11 min-w-11 ..." />
// RestaurantCard Quick Add (py-2 text-xs ~30px) -> shared <Button size="sm"> (min-h-[44px])
// admin support-tickets/audit-logs px-2 py-1 text-xs (~27px) -> add min-h-[44px]
```
### 7.3 Shared envelope fetch helper (kill the `res.json()` w/o `res.ok` smell)
```ts
// packages/client/parseEnvelope.ts (hoisted), used by consumer/vendor/admin
export async function parseEnvelope<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const body = await res.json();
  if (!body?.success) throw new Error(body?.error?.message ?? "Request failed");
  return body.data as T;
}
```
### 7.4 Vendor fetch boilerplate ×8 → one hook
```ts
// apps/vendor/lib/vendorFetch.ts — single useVendorData<T>(path, deps) hook owning
// loading/error/data + AbortController; every page drops its inline useCallback fetch.
// Also import { RESTAURANT_ID } from "@/lib/constants" (done this session).
```
### 7.5 DTO / OTP dedup
- `Restaurant`/`MenuItem` redeclared in 3 libs → `import type { ... } from "@snakzap/types"` (zod-inferred).
- 3 separate OTP inputs (consumer `OtpInput`, vendor inline, admin login) → one shared `OtpInput` in `packages/ui`; admin also re-implements device-fingerprint.
- `space-2xs..2xl` tokens: adopt on key surfaces (`p-space-sm`, `gap-space-md`) or drop from the preset.
- Hex colors in tsx (checkout `#0D9488`, CartDrawer, ToastProvider, QrCode, admin dashboard) → token classes (`text-primary-*`, `bg-neutral-*`).

## 8. Verification (post-fix)

| Suite | Result |
|---|---|
| API + packages (`pnpm test`) | 39 files / **375 tests** pass (was 372; +2 on-screen demo OTP, +1 demo-resilience fallback) |
| consumer (`--filter consumer test`) | 17 files / **77 tests** pass (was 75; +2 login demo-OTP) |
| vendor (`--filter vendor test`) | 2 files / **9 tests** pass |
| admin (`--filter admin test`) | 3 files / **20 tests** pass (+3 orders RTL) |
| typecheck (`pnpm typecheck`, turbo) | 8/8 tasks pass |
| lint (`pnpm lint`, turbo) | 8/8 tasks pass, **0 errors and 0 warnings** (17 consumer + 1 vendor warnings fixed) |

New regression tests: `otp.test.ts` (+3), `auth.test.ts` (+1 on-screen demo OTP), `login.test.tsx` (2), `fulfillment.test.ts` (+1), `orders.test.tsx` (3), `MenuItemsList.test.tsx` (2).

## 10. Demo on-screen OTP (this task)

- **API**: `apps/api/src/services/otp.ts` — `sendOtp` returns `demoOtp` (the real generated code) whenever `NODE_ENV !== "production"`; never exposed in production.
- **Consumer**: `apps/consumer/app/login/page.tsx` — after send-otp, a dashed callout shows the demo code on-screen and prefills the OTP inputs so the demo is one-click; the old "use any 6 digits" hint (only true with `DEV_BYPASS_OTP`) is gone.
- **Wire**: `apps/consumer/lib/store.ts` surfaces `demoOtp` from `sendOtp`; auth route passes it through the envelope unchanged.
- **Pickup OTP** (4-digit) was already on-screen via `apps/consumer/app/orders/[id]/page.tsx` QR block — no change needed.
- **Dev-mode automatic login (Invalid OTP / OTP expired can never happen in dev):** `verifyOtp` in non-production accepts ANY well-formed 6-digit code (no `DEV_BYPASS_OTP` env required — the env-flag mechanism was removed as redundant). Covers stale browser bundles (old "any 6 digits" hint), manual entry, single-use consumption, TTL expiry, and dev-server restarts wiping the in-memory `MemoryRedis`. Production keeps strict Redis-backed `OTP_EXPIRED`/`OTP_INVALID` with constant-time compare. Verified live via the consumer proxy: random code `111111` logs in while `demoOtp` was `629145`.

## 9. Sprint note pointers
- sprint-6 reality-check → `work-logs/sprint-6/reality-check.md` (re-verification appended)
- sprint-7 security/devops → `work-logs/sprint-7/security-devops-hardening.md` (this session's security + devops fixes appended)
- sprint-8 UI/UX → `work-logs/sprint-8/ui-renaissance.md` (motion/domMax correction appended)
- sprint-10 alignment → `work-logs/sprint-10/ui-alignment.md` (compliance re-check + open WARNs appended)
