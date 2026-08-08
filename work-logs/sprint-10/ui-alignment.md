# Sprint 10 - UI Alignment & Human-Centric Design System

**Date:** 2026-08-08
**Branch:** main
**Goal:** Enforce a strict, tokenized design system across SnakZap after a visual review found arbitrary Tailwind classes, inconsistent spacing, and broken layouts. Fix global alignment, mobile safe areas, touch targets, and spatial rhythm.

---

## 1. Global Container Strategy

### Problem

Every page defined its own horizontal constraints (`mx-auto max-w-5xl px-4 py-6`) independently. The result:

- Inconsistent gutters (some pages `px-4`, others `px-5`, `p-4`, no padding on cards).
- Duplicated max-width logic scattered across 20+ pages.
- No single source of truth for page width.

### Strategy

A single `<Container>` component in `packages/ui` becomes the ONLY place that owns horizontal rhythm:

```tsx
<Container>                 // mx-auto w-full max-w-5xl px-4 sm:px-6
```

- **Owns**: `max-width` (`max-w-5xl`), horizontal centering (`mx-auto w-full`), and the mobile-to-desktop gutter (`px-4 sm:px-6`).
- **Consumer**: mounted once in `apps/consumer/app/layout.tsx`, wrapping all page children. Pages drop their own `mx-auto max-w-5xl px-4` and keep only vertical padding (`py-*`).
- **Vendor**: mounted in `VendorLayoutClient` around all non-dashboard pages. The KDS dashboard (`h-dvh` full-bleed Kanban) intentionally bypasses the Container so the kitchen display keeps its immersive full-screen grid.
- **Narrow pages** (group-cart `max-w-2xl`, vendor forms `max-w-3xl`) keep `mx-auto max-w-*` on the page `<main>` but drop `px-4`; the Container provides the gutter exactly once, so no double-padding.
- **Result**: one file controls global width/gutter; pages only manage vertical space.

## 2. Spacing Tokens

### Problem

Ad-hoc utilities like `p-3`, `gap-3`, `mb-2.5`, and unused custom values (`18`, `88`, `128`) created inconsistent vertical rhythm and no repeatable vocabulary.

### Strategy

Define a semantic spacing scale in `packages/config/tailwind.config.ts` under `theme.extend.spacing`. These tokens compose with Tailwind's default numeric scale (which already maps 1 unit = 0.25rem):

| Token | Value |
|-------|-------|
| `space-2xs` | 0.25rem (4px) |
| `space-xs` | 0.5rem (8px) |
| `space-sm` | 1rem (16px) |
| `space-md` | 1.5rem (24px) |
| `space-lg` | 2rem (32px) |
| `space-xl` | 3rem (48px) |
| `space-2xl` | 4rem (64px) |

Usage: `p-space-sm`, `gap-space-md`, `mt-space-lg`. Key surfaces (Container gutters, nav, drawers, KDS tickets, discovery grids) now use the token vocabulary. The unused arbitrary values `18/88/128` were removed.

## 3. Safe Areas & Thumb-Zone Optimization

### Problem

Fixed bottom surfaces (Consumer BottomNav, KDS action buttons) overlap iOS home-indicator/Android gesture bars on notch devices. Interactive elements were often smaller than the 44x44dp Apple/Android minimum touch target.

### Strategy

- CSS `env(safe-area-inset-*)` utilities in both `globals.css` files:

```css
.pt-safe { padding-top: env(safe-area-inset-top, 0px); }
.pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }
.pl-safe { padding-left: env(safe-area-inset-left, 0px); }
.pr-safe { padding-right: env(safe-area-inset-right, 0px); }
```

- **BottomNav** (consumer): `pb-safe` on the `<nav>` with the tab strip pinned to a 64px (`h-16`) hit area above the inset, so tabs never sit under the home indicator.
- **CartDrawer / Sheet**: `pb-safe` on the scrollable content so CTAs clear the home indicator.
- **Touch targets**: `min-h-[44px]` enforced on all major interactive controls:
  - `packages/ui` `Button` `md`/`lg` sizes (systemic, covers every primary/secondary CTA).
  - KDS "Advance"/"Hand Over" buttons, OTP input.
  - CartDrawer quantity steppers + primary CTAs.
- A `.min-h-touch` / `.min-w-touch` utility is available for non-button controls.

## 4. Visual Hierarchy (Consumer)

- Discovery feed uses a strict CSS Grid: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4` (no broken flex wraps).
- Typography normalized to the existing token scale; removed arbitrary sizes (`text-[10px]` → `text-2xs`, `text-[11px]` → `text-xs`). Headings are `font-bold`, body `text-base font-normal`.
- CartDrawer: slides up with a `translate-y` transition (mount → open), consistent `p-space-sm`-based padding for item list / price breakdown / CTAs, and bottom safe-area clearance.

## 5. Vendor KDS Alignment

- The Kanban stage container is a strict CSS Grid: `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 p-4` (responsive: 2 stages on phones, up to 4 on xl screens) instead of a fixed `flex min-w-[960px]` overflow row.
- Each column is `flex min-h-0 flex-col`; the ticket list scrolls within the column.
- Order tickets use `flex flex-col justify-between` with the items list `flex-1`, so Timer / Items / Action Button align consistently and action buttons pin to the bottom of every ticket regardless of item count.

## 6. Verification

- RTL tests: `<Container>` renders `max-w-5xl` + `px-4 sm:px-6`; `maxWidth` variants; `Button` md/lg enforce `min-h-[44px]`.
- Grep audit across `apps/consumer` + `apps/vendor`: no `text-[*]` arbitrary sizes remain; all primary CTAs carry `min-h-[44px]`.
- Full backend + consumer test suites, typecheck (4 apps), and ESLint on changed files.
