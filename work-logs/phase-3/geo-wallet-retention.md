# Phase 3 Completion: Geo-fence, Wallet, Spice Profile & Cart Persistence

- Features: P02 Geo-fence Detection, O12 SnakZap Wallet & Cashback, D03 Spice
  Tolerance Profile, L02 Pickup Streak Badge, O09 Cart Persistence
- Phase: Phase 3 (User Growth)
- Role: Backend (Fulfillment, Loyalty, Ordering, Identity contexts) + UI/UX Agent
- Status: COMPLETE

## 1. Scope

Closes Phase 3 with the geo-fence auto-check-in, wallet cashback ledger,
spice-aware menu filtering, pickup streak badges, and 24-hour cart
persistence - all wired through the EOS event catalog (17 -> 21 events).

## 2. P02 Geo-fence Detection - Haversine radius

The fence radius is computed with the haversine great-circle formula (already
shared in `services/discovery.ts` and reused here):

```
a = sin^2(dLat/2) + cos(lat1) * cos(lat2) * sin^2(dLng/2)
d = 2 * R * asin(sqrt(a)),  R = 6371 km
```

`POST /api/v1/orders/:id/location-update` receives the user's `lat`/`lng` and
compares against the order restaurant's coordinates:

- `distance_m = haversineKm(user, restaurant) * 1000`
- **Inside the fence** (`distance_m <= 100`) **and** `status ===
  READY_FOR_PICKUP` -> trigger Auto Check-in (P03, `orderRepo.setCheckedIn`)
  and emit `UserArrivedAtRestaurant { order_id, user_id, restaurant_id,
  distance_m, auto_checked_in }`.
- Outside the fence, or not READY_FOR_PICKUP -> report `within_fence` /
  `auto_checked_in: false`, no state change.

This is the "arrival = location, not button tap" seam: the consumer app
streams location on the order-tracker screen and the server decides.

## 3. O12 SnakZap Wallet & Cashback - ledger

The wallet is a **double-entry ledger**, not a balance field. Every credit
writes a `WalletTransaction` row `{ id, user_id, amount, reason, order_id,
created_at }`; balance is derived from the ledger (kept in sync on the wallet
row for O(1) reads).

- Hook: a retention handler subscribes to `OrderPickedUp`. For each picked-up
  order it credits **1% of `order.total_amount`**:
  `cashback = round2(total_amount * 0.01)` (Rs 500 -> Rs 5).
- `GET /api/v1/loyalty/wallet` returns `{ balance, total_earned, transactions[] }`.
- Emits `WalletCashbackCredited { user_id, order_id, amount, balance_after }`.

Referral credits reuse the same ledger, so the history shows every credit
source with its reason (`referral_bonus`, `pickup_cashback`).

## 4. D03 Spice Tolerance Profile

`PUT /api/v1/users/profile` updates `spice_tolerance` (1-5) on the identity
record and emits `SpiceProfileUpdated`. Each menu item carries a
`spice_level` (1-5). The consumer menu endpoint resolves the effective
tolerance from (query param -> authenticated user's profile) and filters out
items with `spice_level > tolerance`, so a tolerance-2 user never sees a
5-chili dish.

## 5. L02 Pickup Streak Badge

Streak state per user: `{ current_streak, best_streak, last_pickup_day,
badges[], coupons[] }`. On `OrderPickedUp`, record the pickup day (UTC
`YYYY-MM-DD`):

- same day -> no change (idempotent per day)
- yesterday -> `current_streak += 1`
- otherwise -> reset to 1

When the streak reaches a multiple of 7, a **10% off coupon** is minted
(`discount_rate: 0.10`, 30-day expiry), appended to `badges`, and
`StreakBadgeUnlocked { user_id, streak, coupon_code, discount_rate }` is
emitted. `GET /api/v1/loyalty/streak` surfaces current/best streak + badges +
active coupons for the profile UI.

## 6. O09 Cart Persistence - 24-hour inactivity TTL

The cart is persisted server-side in Redis under `cart:{userId}` with:

1. A **Redis EX TTL of 24h** set on every save, so a cart naturally expires
   after 24 hours of inactivity (each add refreshes the window).
2. A **read-time inactivity guard**: on `GET`, if `now - saved_at > 24h` the
   entry is deleted and the client learns it expired (`expired: true`).

`POST /api/v1/cart` saves the full cart state (restaurant + line items);
`GET /api/v1/cart` returns it; `DELETE /api/v1/cart` clears it. The consumer
cart store fires-and-forgets a save on every mutation and hydrates on app
load when the persisted cart has not expired.

## 7. Event Catalog additions (EOS Layer 1, 17 -> 21)

| Event | Payload |
|---|---|
| `UserArrivedAtRestaurant` | `{ order_id, user_id, restaurant_id, distance_m, auto_checked_in }` |
| `WalletCashbackCredited` | `{ user_id, order_id, amount, balance_after }` |
| `StreakBadgeUnlocked` | `{ user_id, streak, coupon_code, discount_rate }` |
| `SpiceProfileUpdated` | `{ user_id, spice_tolerance }` |

## 8. Verification plan

- Geo-fence: 50 m away + READY_FOR_PICKUP -> `auto_checked_in: true`;
  500 m away -> ignored.
- Wallet: pickup of a Rs 500 order -> wallet balance 5; ledger row recorded.
- Streak: 7 consecutive pickup days -> 10% coupon + badge + event.
- Cart: save -> get round-trips; inactivity > 24h (injected clock) -> expired
  and cleared.
- Spice: tolerance 2 -> menu omits a 5-chili item.
- Full `pnpm vitest run` + turbo typecheck; live verify on API :3001 and
  consumer :3000.
- Evidence manifest: `work-logs/phase-3/verification.json`.

## 9. Result (Task 16)

All five Phase 3 features shipped end-to-end and verified:

- **Full suite green**: 254 tests across 31 files pass (`pnpm vitest run`);
  `turbo typecheck` green for `@snakzap/api`, `@snakzap/consumer`,
  `@snakzap/types` (21-event catalog).
- **P02 geo-fence** (`routes/geoFence.test.ts`, 5 tests): 44 m + READY_FOR_PICKUP
  -> auto check-in + `UserArrivedAtRestaurant`; 2,102 m -> `within_fence: false`,
  no state change; wrong status / bad coords / unknown order handled.
- **O12 wallet** (`services/retention.test.ts` + `routes/retention.test.ts`):
  1% cashback (Rs 500 -> Rs 5) with append-only ledger; live: Rs 242.80 order
  credited Rs 2.43 and surfaced on `GET /loyalty/wallet`.
- **L02 streak**: 7 consecutive days -> `SNKZ-STREAK-7` 10% coupon +
  `StreakBadgeUnlocked`; same-day idempotent; gap resets to 1.
- **O09 cart** (`routes/cart.test.ts` + `services/cartPersistence.test.ts`,
  12 tests): POST/GET/DELETE round-trip, per-user scoping, injected-clock 24h
  expiry guard + Redis EX TTL; consumer CartDrawer hydrates on mount and
  fire-and-forget persists on every mutation.
- **D03 spice**: `PUT /api/v1/users/profile` (1-5) + `SpiceProfileUpdated`;
  menu endpoint resolves tolerance (query > profile) and filters. Live: a
  tolerance-2 user's Biryani House menu shows only Veg Biryani.
- **Consumer UI** (profile page): Wallet & Rewards section (balance, total
  earned, current/best streak, days to next badge, badge chips, cashback
  history) + Spice Profile 5-flame slider (inline SVG, no emoji) that persists
  on tap. Live pages return 200 on :3000.
- **Live verification** on API :3001 exercised the full happy path (OTP login,
  order -> payment -> READY_FOR_PICKUP -> location-update -> confirm-pickup ->
  wallet/streak/profile/cart) with realistic outputs.
