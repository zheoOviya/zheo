# Sprint 8: UI/UX Renaissance & Premium Design System

**Date:** 2026-08-08
**Status:** IN PROGRESS
**Trigger:** Frontend audit: "functional but sterile" at ~4/10.

## Goal

Transform the frontend architecture from a functional prototype into a premium, motion-rich food ordering experience. No backend changes allowed.

## Design System: Project Teal

### Design Tokens (Tailwind preset extension)
- **Typography**: Sans-serif stack with defined scale (xs through 4xl), tight letter-spacing for headings
- **Spacing**: 4px grid (0.5rem = 2 units)
- **Shadows**: 5-level depth system (`sm` through `2xl`) with teal-tinted dark mode variants
- **Border Radius**: 4-stop scale (`sm` = 6px, `md` = 10px, `lg` = 16px, `xl` = 24px)
- **Glass Morphism**: `backdrop-blur-xl` with `bg-white/70 dark:bg-neutral-900/70` utilities
- **Animations**: Framer Motion integration with `scaleOnTap`, `liftOnHover`, page transitions

### Component Architecture (`packages/ui`)
1. **`Button`** — 4 variants (primary/secondary/ghost/destructive), 3 sizes, hover lift (translateY(-2px) + shadow), tap scale (0.97)
2. **`Card`** — Glass-morphism card with optional hover lift, padding variants, header/footer slots
3. **`BottomNav`** — Persistent bottom tab bar with icon+label, active indicator, cart badge
4. **`ActiveOrderBar`** — Animated status bar surfacing live order state above bottom nav
5. **`Sheet`** — Bottom sheet for quick-add customization
6. **`Badge`** — Rank badge (#1, #2, #3) and metadata chips
7. **`CountdownTimer`** — Live countdown for KDS tickets

## Task 1: Premium Design System

### Design Tokens
- Extended `snakZapPreset` in `packages/config/tailwind.config.ts` with typography, spacing, shadow, borderRadius, and glass-morphism utilities
- Added `glass`, `glass-dark`, `lift`, `tap` utility classes

### Components (all in packages/ui/src/)
- `Button.tsx` — Primary (teal, white text), Secondary (ghost teal border), Ghost (transparent), Destructive (red). 3 sizes: sm, md, lg. All have `whileHover` and `whileTap` Framer Motion.
- `Card.tsx` — Glass-morphism card wrapper. Optional `hoverable` prop adds lift animation. Slots: `Card.Header`, `Card.Content`, `Card.Footer`.
- `BottomNav.tsx` — Fixed bottom bar with slots for `BottomNav.Item` (icon, label, href, badge). Animated active indicator (LayoutGroup).
- `ActiveOrderBar.tsx` — Collapsible bar above bottom nav showing order status with pulsing dot and ETA.
- `Sheet.tsx` — Bottom sheet with drag handle, backdrop, and AnimatePresence.
- `Badge.tsx` — Small pill/chip component for metadata (Prep Time, Queue, Sold count).
- `CountdownTimer.tsx` — Live countdown for KDS use.

## Task 2: Consumer Navigation

### Bottom Tab Bar
- 4 tabs: Home (house icon), Orders (clock icon), Cart (shopping bag + badge), Profile (user icon)
- Cart badge shows item count from Zustand store
- Active tab has teal underline indicator with LayoutGroup animation
- Fixed at screen bottom, z-50

### Framer Motion Integration
- Installed `framer-motion` in consumer app
- Added `LazyMotion` + `domAnimation` in root layout for tree-shaking
- Page transitions: `AnimatePresence` with fade+slide
- `scaleOnTap` (0.97) utility on interactive elements
- `liftOnHover` (translateY -2px + shadow) on cards

### Active Order Status Bar
- Surfaces between content and bottom nav when user has an active order
- Shows: restaurant name, status badge, ETA countdown
- Animated entrance (slide up from bottom)
- Tap navigates to order detail

## Task 3: Discovery Feed Redesign

### Restaurant Card Redesign
- Cards now show: restaurant image (or gradient placeholder), name, rating, prep time chip, queue status chip (Light/Moderate/Busy), today's order count
- "Open Now" pulse indicator (green dot with ping animation)
- Quick-Add button triggers a bottom sheet with menu items

### Quick-Add Bottom Sheet
- Opens on "Quick Add" tap from restaurant card
- Shows 3-5 most popular menu items
- Each item has a one-tap add-to-cart button
- Animated entrance via Sheet component

### Trending Carousel
- Horizontal scroll with rank badges (#1 gold, #2 silver, #3 bronze)
- "X sold today" social proof text
- Item image with price overlay
- Framer Motion scroll-driven entry animations

## Task 4: Vendor KDS Redesign

### Kanban Layout
- 4 columns: New Orders, Preparing, Almost Ready, Ready for Pickup
- Columns scroll vertically independently
- Each order card is color-coded by time-in-state

### Urgency Color System
- Green (just arrived, < 3 min in state)
- Amber (approaching expected time, 3-7 min)
- Red (exceeding expected prep time, > 7 min)
- Background tint + left border accent

### Order Card Design
- Large order number (#ORDER-1234)
- Item list with quantities
- Prep time countdown timer (live)
- One-tap status advance button
- Customer name

### Layout
- Full-viewport height, dark theme native
- Top bar: restaurant name, clock, connection status
- Columns fill remaining height
- Large touch targets (> 48px)

## Task 5: Tests

### Bottom Navigation Tests
- Renders all 4 tabs
- Active tab has correct styling
- Cart badge shows correct count
- Tab click triggers navigation

### Quick-Add Tests
- Sheet opens on button click
- Menu items render
- Add-to-cart dispatches to store

## Verification
- `pnpm typecheck` on all packages
- `pnpm test` via vitest
- Manual verification of motion components
- React Testing Library tests for interactive components

## Artifacts
- `packages/config/tailwind.config.ts` (redesigned)
- `packages/ui/src/Button.tsx`, `Card.tsx`, `BottomNav.tsx`, `ActiveOrderBar.tsx`, `Sheet.tsx`, `Badge.tsx`, `CountdownTimer.tsx`
- `packages/ui/index.ts` (updated barrel)
- `apps/consumer/app/layout.tsx` (redesigned with BottomNav)
- `apps/consumer/components/RestaurantCard.tsx` (redesigned)
- `apps/consumer/components/QuickAddSheet.tsx` (new)
- `apps/consumer/components/TrendingCarousel.tsx` (redesigned)
- `apps/vendor/app/page.tsx` (KDS redesign)
- `apps/vendor/app/layout.tsx` (KDS dark mode layout)
- `apps/consumer/components/__tests__/BottomNav.test.tsx`
- `apps/consumer/components/__tests__/QuickAddSheet.test.tsx`
- `work-logs/sprint-8/verification.json`

---

## Sprint 8 Re-Audit (2026-08-09) — Motion correction + spec-drift check

Full project re-audit verified the sprint-8 motion integration. One real defect found and fixed:

- **FIXED — KDS motion silently disabled:** `apps/vendor/app/page.tsx` uses `m.div layout` + `AnimatePresence mode="popLayout"` (kanban columns), but `VendorLayoutClient.tsx` loaded `LazyMotion features={domAnimation}`. Verified in framer-motion 13.0.0 source (`motion/index.mjs` → `getProjectionFunctionality`): the `layout` feature is registered by the **`domMax`** bundle only, so `MeasureLayout`/`ProjectionNode` were `undefined` — the `layout` prop was a silent no-op (cards snapped, no popLayout exit). **Fix (motion import correction):** `VendorLayoutClient.tsx` now imports `domMax` instead of `domAnimation`. `exit` + `popLayout` now animate as sprint-8 intended. No crash either way (verified: strict mode only throws for `motion.X` components, and the KDS uses `m.*`).
- **Spec drift (documented):** `packages/ui` Button/Card/BottomNav are CSS-only (`active:scale-[0.97]`, hover lift, LayoutGroup indicator absent) — no framer-motion in the shared UI package. Functional, tree-shaking-safe, but deviates from the sprint-8 "whileHover/whileTap/LayoutGroup" spec. Options: adopt `m.` variants under each app's existing LazyMotion, or formally declare the CSS approach.
- Consumer `m.*` usage (RestaurantCard, RestaurantGrid, PersonalizedFeed, TrendingCarousel) verified compatible with `LazyMotion domAnimation strict` (initial/animate only).

**Verification:** vendor 9 tests pass; consumer 75; typecheck 8/8; lint 8/8. Full detail in `work-logs/full-reaudit.md`.

