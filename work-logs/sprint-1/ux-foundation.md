# Sprint 1 - UX Foundation (Work Log)

**Sprint:** 1
**Task:** 21 - UX Foundation
**Date:** 2026-08-07
**Agent:** Lead Frontend & UI/UX Agent
**Status:** COMPLETE

## Verification Results

| Check | Result |
|-------|--------|
| API typecheck | 5/5 packages (`turbo run typecheck`) PASS |
| Root test suite | 36 files, 298 tests PASS (292 + 6 new orders-history route tests) |
| Consumer RTL suite | 5 files, 24 tests PASS (onboarding 8, orders 6, add-flow 3, QrCode 4, qr roundtrip 3) |
| Total tests | 322 |
| Live smoke: `POST /api/v1/orders` | 201 DRAFT, correct breakdown |
| Live smoke: `GET /api/v1/orders?page=1&limit=5` | total/pages correct, `restaurant_name` joined |
| Consumer pages | `/onboarding` 200, `/orders` (AuthGate redirect) 307, `/` 200; dev server compiles clean |
| Preview | https://3000-519060a9af2c6382.monkeycode-ai.live |

### Acceptance Coverage

- **I-01** Onboarding: 3-slide swipe carousel, Skip/Get Started, `snakzap_onboarded`
  flag + redirect, `role="region"`/`aria-roledescription`, Prev/Next keyboard
  buttons, dots, reduced-motion classes. Tested (8 tests).
- **I-02** Real QR: `qrcode` package, JSON payload `{orderId, otp, v:1}`, EC 'H',
  SVG-rendered genuine QR; tap-to-enlarge modal, Max Brightness, large mono OTP,
  Copy OTP. Scannability proven via jsQR decode round-trip.
- **I-03** Order History: paginated `GET /api/v1/orders` (zod-validated), cards
  with restaurant name/date/items/total/status, Reorder re-places order + pre-fills
  cart, skeletons `aria-busy="true"`. API tested (6 new route tests) + UI (6 tests).
- **I-04** Cross-restaurant guard: `addItem()` returns snapshot result; warning
  toast with exact copy + Undo restores cart via `restoreSnapshot()`. Tested.
- **I-07** Add feedback: confirm button spinner (`disabled` + `aria-busy`), 300ms
  green checkmark, ref-guard drops duplicate taps, row button flashes check. Tested.
- **I-10** Toasts: `role="alert"` + `aria-live="assertive"`, top-center mobile /
  bottom-right desktop, max 3 visible (oldest dismissed). Tested via add-flow suite.

## Notes

- react-hot-toast 2.4.1 pinned: `ToasterProps` no longer exposes a `limit` prop in
  newer versions, so the max-3 cap is enforced in `ToasterHost` via
  `useToasterStore()` (dismiss oldest beyond 3).
- QR rendered as SVG from `QRCode.create()` module matrix (no canvas dependency),
  so it is pixel-crisp and decodes reliably at any size; `matrixToImageData` +
  `jsQR` in tests prove genuine scannability.
- `next lint` is not configured in this repo (interactive prompt); typecheck is
  the enforced static gate. All 5 packages typecheck clean.


## Scope

Six acceptance criteria from the Sprint 1 UX backfill (I-01, I-02, I-03, I-04,
I-07, I-10) plus Task 6 (RTL tests + verification.json).

| ID | Feature | Where |
|----|---------|-------|
| I-01 | Onboarding carousel | `apps/consumer/app/onboarding/page.tsx` |
| I-02 | Real scannable QR | `apps/consumer/components/QrCode.tsx` |
| I-03 | Order History + Re-Order | `apps/api/src/routes/orders.ts` + `apps/consumer/app/orders/page.tsx` |
| I-04 | Cross-restaurant cart warning + Undo | `apps/consumer/lib/store.ts` + `components/MenuItemsList.tsx` |
| I-07 | Add-to-cart loading states | `components/MenuItemsList.tsx` + `components/CustomizationPicker.tsx` |
| I-10 | Toast system | `apps/consumer/app/layout.tsx` + `components/ToasterHost.tsx` |

## Constraints & Decisions

1. **Persona**: Lead Frontend & UI/UX Agent. Adhere to ZHEO v3 EOS and the
   existing teal `snakZapPreset` design tokens. No new color systems.
2. **A11y baseline**: WCAG 2.1 AA - `role="alert"` + `aria-live="assertive"`
   toasts, `role="region"` + `aria-roledescription="carousel"` for the
   onboarding carousel, keyboard-navigable carousel controls, `aria-busy`
   during async loading, `prefers-reduced-motion` respected.
3. **QR strategy**: Use the `qrcode` npm package's `QRCode.create()` (pure JS,
   no canvas dependency) to build the module matrix and render it as an SVG.
   Payload is `JSON.stringify({ orderId, otp, v: 1 })`, error correction level
   `'H'`. This is a genuine QR code (not the previous seeded SVG placeholder).
   Scannability is proven in tests by reconstructing an image buffer from the
   module matrix and decoding it back with `jsQR` (dev-only decoder).
4. **Toast position**: A single `<Toaster/>` mounted in the root layout via a
   small client `ToasterHost` that switches `position` between
   `top-center` (mobile) and `bottom-right` (desktop, `>= 768px`) using
   `window.matchMedia`. `limit={3}` caps simultaneous toasts.
5. **Cross-restaurant guard**: `useCartStore.addItem()` now *returns* a
   discriminated result. When the incoming item is from a different restaurant
   it snapshots the current cart, clears it, and returns
   `{ cleared: true, previousRestaurantName, clearedItemCount, snapshot }`.
   The UI layer shows the warning toast with an **Undo** action that restores
   the snapshot via a new `restoreSnapshot()` store action. The store keeps
   single-restaurant enforcement (PRD) - the toast makes the destructive
   behavior visible instead of silent.
6. **Add feedback**: The 3-tap flow means the real "add" happens on the
   CustomizationPicker confirm button. Feedback lives there: 400ms spinner
   (`disabled` + `aria-busy`) then a 300ms green checkmark, guarded by a ref so
   concurrent taps are dropped. The matching menu row button also flashes a
   green check so the user sees where the item landed.
7. **Reorder pre-fill**: Reorder calls the existing
   `POST /api/v1/orders/reorder` (which places the new order server-side) and
   then pre-fills the local cart from the *source* order's line items
   (`GET /api/v1/orders/:id`) so the user can adjust or check out again.
8. **Pagination**: New repo method `getByUserPaginated(userId, page, limit)`
   returning `{ orders, total }`; route validates `page`/`limit` with zod
   (defaults 1/10, limits 1..50); response includes `restaurant_name` joined
   from the catalog for card rendering.

## Files

- `apps/consumer/app/onboarding/page.tsx` (new)
- `apps/consumer/components/QrCode.tsx` (rewrite)
- `apps/consumer/components/QrModal.tsx` (new, tap-to-enlarge + brightness)
- `apps/consumer/components/ToasterHost.tsx` (new)
- `apps/consumer/app/layout.tsx` (mount ToasterHost)
- `apps/consumer/lib/store.ts` (addItem result + restoreSnapshot + restaurantName)
- `apps/consumer/components/MenuItemsList.tsx` (cross-restaurant toast + add states)
- `apps/consumer/components/CustomizationPicker.tsx` (pending/success states)
- `apps/consumer/lib/api.ts` (fetchOrderHistory + types)
- `apps/consumer/app/orders/page.tsx` (new)
- `apps/api/src/routes/orders.ts` (GET /api/v1/orders paginated)
- `apps/api/src/repositories/orderRepository.ts` (getByUserPaginated)
- `apps/consumer/package.json` (deps) + `apps/consumer/vitest.config.ts` (new)
- `apps/consumer/vitest.setup.ts` (new)

## Dependencies to Add

- deps: `qrcode`, `react-hot-toast`
- devDeps: `@types/qrcode`, `vitest`, `@testing-library/react`,
  `@testing-library/dom`, `@testing-library/jest-dom`,
  `@testing-library/user-event`, `jsdom`, `jsqr`

## Verification Plan

1. `pnpm --filter @snakzap/consumer typecheck`
2. `pnpm --filter @snakzap/consumer exec vitest run` (consumer RTL tests)
3. `pnpm test` (root - ensure 292 API/package tests still green)
4. Consumer tests prove: onboarding flow + localStorage flag; order history
   skeleton/cards/reorder; cross-restaurant toast + Undo restore; QR module
   matrix decodes back to the exact payload with jsQR.
5. `work-logs/sprint-1/verification.json` generated with all checks.
