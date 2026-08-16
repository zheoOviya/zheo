# P2-001 POS Integration & Customer Insights (Vendor Retention)

- Feature: V01 Petpooja POS Integration, V08 Customer Insights Dashboard
- Context: SnakZap - Vendor Ops (vendor retention phase)
- Date: 2026-08-05

## Scope

Two vendor-retention capabilities for Phase 2 plus the identity stability
needed to make them meaningful:

1. **V01 Petpooja POS Integration** - inbound order webhook receiver + menu
   sync from the Petpooja POS.
2. **V08 Customer Insights** - repeat rate, AOV and peak-hours aggregation for
   the vendor dashboard.
3. **Stable customer identity** - a phone-keyed user repository so repeat-rate
   math is correct (previously auth minted a random user id per login).

## Petpooja Webhook Receiver Strategy (V01)

`POST /api/webhooks/pos/petpooja` receives orders pushed from Petpooja.

### Delivery contract

Petpooja pushes a signed JSON body. Header `x-petpooja-signature` must be an
HMAC-SHA256 of the raw body using `PETPOOJA_WEBHOOK_SECRET`:

```
signature = hex( HMAC_SHA256( secret, rawBody ) )
```

Mirroring the Razorpay webhook seam, signature verification runs in mock mode
(`valid_sig_` prefix accepted) when `NODE_ENV=test` or no secret is
configured, and enforces the real HMAC in production.

### Payload shape

The receiver expects a flat payload (no `event` wrapper):

```json
{
  "pos_order_id": "PTP-20260805-0001",
  "restaurant_id": "a0000000-0000-4000-8000-000000000001",
  "customer_phone": "+919876543210",
  "ordered_at": "2026-08-05T12:30:00.000Z",
  "items": [
    {
      "pos_item_id": "PTP-1001",
      "name": "Chicken Biryani",
      "quantity": 1,
      "price": 220,
      "customizations": [{ "name": "Extra Masala", "price_delta": 20 }]
    }
  ]
}
```

### Idempotency

Idempotency is keyed on `pos_order_id` (the POS's own order number). A
`PosOrderRepository` records every processed `pos_order_id` mapped to its
SnakZap `order_id`. If Petpooja retries the same order (network retry or
duplicate push), the receiver returns `{ processed: false, idempotent: true }`
and creates **no** duplicate order. The same pattern as the Razorpay webhook
dedup (`findByRazorpayPaymentId`).

### Order creation

POS orders arrive already paid, so the receiver creates the SnakZap order and
advances it straight to `CONFIRMED` (skipping the DRAFT/PAYMENT_PENDING flow).
Items are mapped against the synced catalog by `pos_item_id`; an item that has
not been synced is rejected with `POS_ITEM_NOT_SYNCED` (400) - pricing is
always authoritative from our catalog, never trusted from the POS payload. The
customer is resolved by phone through the identity repository so POS orders and
web orders share a stable customer id. Every received order is written to the
audit trail (`pos_order_received`), including idempotent replays.

## Menu Sync Logic (V01)

`POST /api/vendor/pos/sync-menu?restaurant_id=` triggers a pull from the mock
Petpooja menu API and upserts into `menu_items`.

### Mapping

| Petpooja field | `menu_items` column | Mapping |
|---|---|---|
| `pos_item_id` | `pos_item_id` (new) | idempotency key for sync |
| `name` | `name` | direct |
| `price` | `price` | direct |
| `category` / `dietary` | `dietary_tags` jsonb | `VEG`/`NON_VEG`/`JAIN` flags |
| `addons` | `customizations` jsonb | `[{ name, price_delta }]` |

Upsert semantics: an existing `menu_items` row with the same
`(restaurant_id, pos_item_id)` is updated in place (price, availability,
dietary tags, customizations); a new `pos_item_id` inserts a row. The sync is
therefore idempotent - running it twice converges, it never duplicates. A
`pos_menu_synced` audit row records the item count.

The `ImageStorage` abstraction from V13 is reused unchanged; the mock Petpooja
client returns a deterministic menu per restaurant so tests assert exact
upsert counts.

## Insights Aggregation Queries (V08)

`GET /api/vendor/insights?restaurant_id=&days=30` computes, from the
restaurant's orders in the last N days:

- **Eligibility**: orders with status `CONFIRMED`, `PREPARING`,
  `ALMOST_READY`, `READY_FOR_PICKUP`, `PICKED_UP` or `SETTLED`. DRAFT,
  PAYMENT_PENDING, PAYMENT_FAILED, CANCELLED, EXPIRED, REFUNDED, DISPUTED are
  excluded - only paid/fulfilled orders are insights.

- **Average Order Value (AOV)**: `round(total_revenue / order_count, 2)`.

- **Repeat Rate**: `distinct_users_with_more_than_one_order /
  distinct_users_with_at_least_one_order` (0..1, surfaced as a percentage).
  Because customer ids are now stable per phone, a customer who orders twice
  across sessions is counted once in "repeat".

- **Peak Hours**: distribution of orders by hour of day (0-23) in IST
  (`Asia/Kolkata`), the market timezone. Computed deterministically with the
  `+5:30` offset rather than a locale formatter so tests are stable. Returns a
  fixed 24-bucket array `[{ hour, label, order_count }]`.

## API Surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/webhooks/pos/petpooja` | Petpooja order push (HMAC-verified, idempotent) |
| POST | `/api/vendor/pos/sync-menu` | pull mock Petpooja menu and upsert (audited) |
| POST | `/api/vendor/pos/simulate-order` | push a sample Petpooja order (demo/UI test) |
| GET | `/api/vendor/insights` | AOV, repeat rate, peak hours |

Audit trail entries written: `pos_order_received` (webhook, incl. replays),
`pos_menu_synced` (sync), `pos_order_simulated` (simulate).

## Vendor Dashboard UI (UI/UX Agent)

- **Insights page** (`apps/vendor/app/insights/page.tsx`): metric cards for AOV
  and Repeat Rate (plus order count + revenue), and a Teal bar chart for Peak
  Hours. The chart is a pure-div Teal (`bg-primary-500`) bar layout - no chart
  dependency, bars scale to the busiest hour. Teal-shimmer skeletons while the
  fetch streams.
- **POS Integration page** (`apps/vendor/app/pos/page.tsx`): mock "Connect
  Petpooja" flow (persisted in localStorage), sync status row, "Sync Menu Now"
  and "Send Test Order" buttons, each showing a Teal-shimmer skeleton while in
  flight.
- Shared `VendorNav` gains Insights and POS links.

## Verification

- `apps/api/src/services/insights.test.ts` - pure engine tests: AOV, repeat
  rate with a multi-order customer, IST hour bucketing (+5:30 deterministic),
  12-hour labels, status filtering, zeroed metrics for an empty restaurant.
- `apps/api/src/routes/posWebhook.test.ts` - webhook tests: valid signature
  creates a CONFIRMED order, duplicate `pos_order_id` is idempotent (no second
  order), missing/invalid signature -> 401, malformed payload -> 400,
  unsynced item -> 400, phone-keyed customer identity is stable across orders,
  menu sync converges on a second run, simulate-order works end to end.
- Full suite: **155/155 tests / 19 files**, `turbo typecheck` 5/5 clean.
- Live verification (API 3001): sync-menu returns `{synced: 4}`, webhook
  import returns CONFIRMED order, same `pos_order_id` retry returns
  `{idempotent: true}` with no duplicate order, tampered signature -> 401,
  insights return AOV/repeat-rate/peak-hour buckets after imports. Phone-keyed
  identity verified live: two OTP logins for the same phone return the same
  `user_id`. Vendor preview (3002): `/insights` and `/pos` render 200.
- `work-logs/phase-2/verification.json` evidence recorded.

## Status

COMPLETE.
