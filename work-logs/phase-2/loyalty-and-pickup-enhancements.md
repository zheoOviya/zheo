# P2-003 Phase 2 Completion - Loyalty & Pickup Enhancements

- Features: L05 Refer & Earn, L01 Stamp Card, P15 OTP fallback, P04 Traffic-based ETA, P13 Early Ready Alert
- Context: SnakZap - consumer loyalty + fulfillment pickup enhancements (phase 2 completion)
- Date: 2026-08-05

## Scope

Five Phase-2 features that make the consumer experience sticky:

1. **L05 Refer & Earn** - referral codes, Rs 50 bonus, hard fraud prevention.
2. **L01 Stamp Card** - per-restaurant stamp card, free item at 10 pickups.
3. **P15 OTP fallback** - phone OTP remains the pickup verification fallback next
   to the QR token (already in place via `confirm-pickup`; verified in this task).
4. **P04 Traffic-based ETA** - Google Distance Matrix API with a traffic-aware
   mock fallback when no API key is configured.
5. **P13 Early Ready Alert** - a Push/SMS signal when the order becomes
   `READY_FOR_PICKUP` before its `scheduled_pickup_time`.

New EOS Layer 1 events: `ReferralClaimed`, `StampCardRewardUnlocked`,
`EarlyReadyAlert` (catalog goes 10 -> 13 events). New EOS Layer 2 audit actions:
`referral_applied`, `referral_fraud_blocked`, `stamp_incremented`,
`stamp_card_reward_unlocked`, `early_ready_alerted`. New `loyalty` bounded
context (`repositories/loyaltyRepository.ts`, `services/loyalty.ts`,
`routes/loyalty.ts`).

## Referral Fraud Prevention Strategy (L05)

`POST /api/v1/loyalty/apply-referral` accepts a referral code. Before the Rs 50
bonus is credited, three independent gates run against a dedicated
`referral_claims` store (this task adds a dedicated claims table; in production
this is its own `referral_claims` DB table, not a scan of `audit_logs`):

| # | Gate | Failure |
|---|---|---|
| 1 | Referral code resolves to a real referrer | `400 INVALID_REFERRAL_CODE` |
| 2 | Claimant is not the referrer | `400 SELF_REFERRAL` |
| 3 | Claimant has not already used a referral | `400 REFERRAL_ALREADY_USED` |
| 4 | **Request IP has never claimed** | `403 FRAUD_DETECTED` |
| 5 | **Device fingerprint has never claimed** | `403 FRAUD_DETECTED` |

The **request IP** comes from `x-forwarded-for` (trust proxy) falling back to
`req.ip` / `socket.remoteAddress`. The **device fingerprint** comes from the
`x-device-fingerprint` header - the same EOS Layer 2.3 signal the browser sends
on OTP login, so a second account registered on the same device or network
cannot farm the bonus. On success both the referrer AND the claimant are
credited Rs 50 (`REFERRAL_BONUS = 50`), the claim row is recorded
(claimant, referrer, code, ip, device), the `ReferralClaimed` event is emitted
and the `referral_applied` audit entry is written. A blocked attempt writes
`referral_fraud_blocked` with the failing dimension (ip/device) so the fraud
trail is reviewable.

Because the claim row persists ip + fingerprint, the canonical test proves:
claim once from IP A -> succeeds; claim again from IP A -> `403 FRAUD_DETECTED`.

## Stamp Card State Machine (L01)

Per-restaurant (user_id, restaurant_id) card. Hooks the **`OrderPickedUp`**
event (registered via `registerLoyaltyEventHandlers()` in `app.ts`).

```
                    +------------------------------------------+
                    v                                          |
 [pickup] -> increment stamp_count -> stamp_count >= 10?  ----+
                     |                no: keep count
                     v (yes)
   mark free item unlocked (rewards_earned += 1)
   reset stamp_count -> 0
   emit StampCardRewardUnlocked
```

- `STAMP_CARD_SIZE = 10`; `total_orders` counts every picked-up order.
- On the 10th pickup `rewards_earned += 1`, `stamp_count` resets to 0, and the
  `StampCardRewardUnlocked` event carries `stamp_count_before` and the new
  `rewards_earned` so the notification layer can message "your 10th stamp -
  free item unlocked!". `stamp_incremented` / `stamp_card_reward_unlocked`
  audit entries are written.
- The consumer UI renders the card as 10 circles that fill Teal as pickups
  happen, with a `X/10` counter.

## Traffic-based ETA (P04)

`services/etaService.ts` - `getTrafficETA(origin_lat, origin_lng, dest_lat, dest_lng)`.

When `GOOGLE_MAPS_API_KEY` is set it calls the Google Distance Matrix API:

```
GET https://maps.googleapis.com/maps/api/distancematrix/json
    ?origins=<lat>,<lng>&destinations=<lat>,<lng>
    &departure_time=now&traffic_model=best_guess&units=metric&key=<KEY>
```

`rows[0].elements[0].duration_in_traffic.value` (seconds) is the ETA;
`distance.value / 1000` is the km. `source: "google"`.

When no API key is present it returns a **traffic-aware mock** (`source: "mock"`):
distance via the haversine formula, base in-city speed 25 km/h, and a traffic
multiplier x1.4 during IST rush windows (08:00-11:00, 17:00-20:00) so the
demo ETA varies with the time of day instead of being a flat number. The real
fetch path is unit-tested with an injected fake `fetch`.

Restaurants gain `lat` / `lng` coordinates (DTO + seeds + `0005_loyalty_eta.sql`
migration). `GET /api/v1/eta` returns `{ eta_seconds, duration_text, distance_km, source }`.
The order tracking page geolocates the consumer (fixed Mumbai fallback),
reads the restaurant coordinates, and shows "Leave in ~X min" plus a
`Live traffic` / `Estimated` source badge.

## Early Ready Alert (P13)

In `FulfillmentService.advanceOrderStatus`, when the order transitions to
`READY_FOR_PICKUP` **and** `scheduled_pickup_time` is in the future, the
`EarlyReadyAlert` event is emitted with `{ order_id, restaurant_id,
scheduled_pickup_time, ready_time }`. This is the trigger point for the Push
Notification / SMS producer (out of scope here; the event is the contract).
`advanceOrderStatus` now returns `earlyReadyAlerted: boolean` and the vendor
route writes the `early_ready_alerted` audit entry. Orders with no
`scheduled_pickup_time`, or that are ready late, never emit the alert.

## Consumer UI (UI/UX Agent)

- **`/profile`** (new, AuthGate-wrapped): a **Refer & Earn** card showing the
  user's code with a working **Copy Code** button (clipboard), the Rs 50 offer,
  wallet balance, and an "Apply a referral" input; and a **Stamp Cards**
  section rendering every card as 10 Teal-filling circles with `X/10`.
- **Order Tracking** (`/orders/[id]`): a **"When to leave"** card computing
  traffic ETA from the consumer's location to the restaurant, and a compact
  stamp-card progress ring for that restaurant so the reward stays top-of-mind.

## Verification

- `services/loyalty.test.ts` (11 tests): stable referral codes, Rs 50 credited to
  referrer AND claimant, unknown code 400, self-referral 400, second use 400,
  **same-IP second claim by a different account -> 403 FRAUD_DETECTED** (bonus
  never credited), **same-device second claim -> 403 FRAUD_DETECTED**,
  `ReferralClaimed` emitted on success, stamp increments per pickup, cards are
  per-restaurant, reward unlocks exactly at 10 with reset + 0 -> 10 cycle and
  `StampCardRewardUnlocked` emitted.
- `routes/loyalty.test.ts` (9 tests): end-to-end HTTP - GET /referral
  (stable code, requires auth), apply-referral credits Rs 50, unknown code 400,
  **IP fraud via x-forwarded-for -> 403 with `referral_fraud_blocked` audit**,
  **device fraud via x-device-fingerprint -> 403 with device-dimension audit**,
  stamp card fills through the real OrderPickedUp event, GET /eta returns a
  traffic-aware mock, coordinate validation.
- `services/etaService.test.ts` (8 tests): haversine sanity, IST rush-hour
  factor (1.4 in rush, 1.0 otherwise), mock ETA proportional to distance,
  slower during rush hour, Google Distance Matrix parsing
  (`duration_in_traffic`, departure_time=now, traffic_model=best_guess),
  graceful mock fallback on API error.
- `routes/fulfillment.test.ts` (3 new tests): `early_ready_alerted: true` +
  `early_ready_alerted` audit when ready before `scheduled_pickup_time`,
  silent when ready late or when no `scheduled_pickup_time` is set.
- Full suite: **203/203 tests / 24 files** (was 172; +31 new), `turbo
  typecheck` 5/5 clean.
- Live verification (API 3001): referral code issued; apply from IP A -> 201
  balance Rs 50; same-account repeat -> 400 already-used; **different account,
  same IP -> 403 FRAUD_DETECTED "This network has already claimed a referral";
  fresh IP -> 201**; GET /eta -> source mock, 43 mins / 17.8 km; full pickup
  flow (order + payment CONFIRMED -> READY with `early_ready_alerted: True` ->
  confirm-pickup) -> stamp card shows 1/1. Consumer preview: `/profile` 200,
  `/` 200 (orders page redirects to login when unauthenticated, as designed).
- Evidence: `work-logs/phase-2/loyalty-verification.json`.

## Status

COMPLETE.
