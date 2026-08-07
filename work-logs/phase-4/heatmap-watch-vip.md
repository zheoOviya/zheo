# Phase 4 Completion: Hyperlocal Heatmap (D04), Smart Watch App (W14), VIP Customer Support (L15)

- Task: 19 (Phase 4 Completion)
- Persona: UI/UX Agent (active) + EOS Layer 1 (DDD, Performance)
- Status: COMPLETE

## 1. Objective

Close out Phase 4 (Multi-City & B2B Scale) with three features:

1. **D04 Hyperlocal Heatmap** - real-time order-density aggregation over the
   last 30 minutes, served as lightweight coordinate cells.
2. **W14 Smart Watch App** - an endpoint surface optimized for wearables:
   strictly minimal payloads for active orders and one-tap reorder.
3. **L15 VIP Customer Support** - a VIP tier computed from order history
   (orders > 50 OR spend > Rs 5000), routing VIP tickets to a specialized
   `OPS_AGENT` with HIGH priority.

Contexts: heatmap = **discovery**; watch = **fulfillment/ordering**; VIP =
**loyalty/support**. All wired through the EOS event bus.

## 2. Hyperlocal Heatmap (D04) - Geo-Spatial Aggregation

### 2.1 Algorithm

`GET /api/v1/discovery/heatmap` (public, discovery context)

1. Take the fixed 30-minute window (PRD: "last 30 minutes").
2. Iterate active restaurants with a known `lat`/`lng`.
3. Load that outlet's orders and keep only:
   - `created_at >= now - 30min`, and
   - status NOT in {DRAFT, PAYMENT_PENDING, PAYMENT_FAILED, CANCELLED,
     EXPIRED, DISPUTED, REFUNDED} (reuses the trending exclusion set).
4. **Geo-bucket** each order into an ~110 m grid cell by rounding the
   restaurant coordinate to 3 decimal places (`roundTo(lat, 3)` /
   `roundTo(lng, 3)`).
5. Sum order counts per cell, sort desc, and return a **lightweight** array:

```jsonc
{
  "window_minutes": 30,
  "total_orders": 42,
  "cells": [
    { "lat": 19.076, "lng": 72.878, "count": 18 },
    { "lat": 19.114, "lng": 72.870, "count": 24 }
  ]
}
```

No restaurant objects, no order objects, no PII - only bucketed density so the
payload stays small even at city scale. Emits `HeatmapQueried`.

### 2.2 Performance

One pass per outlet (same shape as D17 trending); the bucket map keeps the
response O(cells) not O(orders). The consumer/admin UI polls at a bounded
30 s interval.

## 3. Smart Watch App (W14) - Minimal Payload Strategy

### 3.1 Principle

Watches have tiny screens, thin radios and small caches. Every watch response
is therefore a **flat object with only the fields a glance needs** - no
nested arrays, no menu items, no prices, no PII. Contract: response bodies
must stay **under 500 bytes**.

### 3.2 `GET /api/v1/wear/orders/active` (auth)

Returns the user's active orders (CONFIRMED..READY_FOR_PICKUP) as a minimal
array:

```jsonc
[
  { "order_id": "...", "restaurant_name": "Biryani House",
    "status": "READY_FOR_PICKUP", "pickup_time": "2026-08-06T12:30:00+05:30" }
]
```

`pickup_time` = `scheduled_pickup_time` when set (the "ready-by" glance the
watch needs). Emits `WearOrderListed`.

### 3.3 `POST /api/v1/wear/orders/reorder` (auth)

One tap reorders the user's most recent order via the existing ordering
context (`OrderingService.reorder`), then returns a minimal confirmation:

```jsonc
{ "order_id": "...", "status": "DRAFT", "total_amount": 245 }
```

No cart UI, no customization pickers - the watch is a single tap. The reorder
reuses the existing `OrderCreated` event path.

## 4. VIP Customer Support (L15) - Tier Calculation

### 4.1 VIP tier logic (loyalty context)

```
eligible orders = orders whose status is a real fulfillment state
                  (excludes DRAFT / PAYMENT_PENDING / PAYMENT_FAILED /
                   CANCELLED / EXPIRED / REFUNDED / DISPUTED)
order_count = eligible.length
total_spend = sum(eligible.total_amount)

VIP iff  order_count > 50  OR  total_spend > 5000
```

Thresholds are exported constants (`VIP_ORDER_THRESHOLD = 50`,
`VIP_SPEND_THRESHOLD = 5000`) so the UI can render progress toward VIP.

### 4.2 `GET /api/v1/support/vip-status` (auth)

Returns `{ is_vip, order_count, total_spend, order_threshold, spend_threshold }`
- consumed by the consumer profile to render the VIP badge + progress.

### 4.3 `POST /api/v1/support/ticket` (auth)

```jsonc
{ "subject": "Cold biryani at pickup", "description": "..." }
```

- Computes VIP for the caller.
- **VIP** -> `priority = "HIGH"`, auto-assignee `"OPS_AGENT"`.
- **Non-VIP** -> `priority = "MEDIUM"`, assignee `null` (general queue).
- Persists the ticket in the support bounded-context repo, emits
  **`VipTicketCreated`** (with `is_vip`, `priority`, `assignee`), and writes an
  audit row.

### 4.4 Data model

`supportRepository.ts` (memory):

```
Ticket { id, user_id, subject, description, priority: LOW|MEDIUM|HIGH,
         assignee: string|null, created_at }
```

## 5. Frontend UI

### 5.1 Admin Dashboard - Heatmap view (apps/admin)

New minimal Next.js app (the admin workspace is currently empty). A
"Live Heatmap" view renders the bucketed cells as a **dot-map grid**: a 24x24
cell grid projected over a city bounding box; each filled cell is a square
whose fill uses teal intensity (`rgba(13, 148, 136, <intensity>)`,
0.15..1.0, scaled by count / maxCount). Headline stats show total orders in
the window and hot-zone count; the grid polls `/api/v1/discovery/heatmap`
every 30 s with a `TealSkeleton` while loading. Same `snakZapPreset` teal
palette. `app/page.tsx` redirects to `/heatmap`.

### 5.2 Consumer Profile - VIP badge + Priority Support (apps/consumer)

- A "VIP Status" card: gold/teal badge when `is_vip`, plus progress bars
  toward both thresholds (orders and spend) when not.
- A "Priority Support" contact button that opens a small ticket form
  (subject + description) and POSTs to `/api/v1/support/ticket`, showing the
  assigned priority / assignee on success. Teal accents, consistent with the
  existing profile UI.

## 6. Event Catalog

22 -> 25: add `HeatmapQueried` (discovery), `WearOrderListed` (fulfillment),
`VipTicketCreated` (loyalty). `WearOrderReordered` is intentionally NOT added -
reorder reuses the existing `OrderCreated` event (no duplicate event).

## 7. Verification Plan

- `heatmap.test.ts`: empty store -> zero cells; orders inside the window +
  non-terminal status counted and bucketed; out-of-window and DRAFT orders
  excluded; cells sorted by count desc; response is lightweight.
- `wear.test.ts`: active-orders returns only restaurant_name/status/
  pickup_time (+order_id); **payload < 500 bytes**; terminal orders excluded;
  reorder returns minimal object and creates a new order; 401 without token.
- `vip.test.ts`: order-count threshold crossing (51 orders -> VIP), spend
  threshold crossing (Rs 5001 -> VIP), non-VIP gets MEDIUM + null assignee,
  VIP gets HIGH + OPS_AGENT; `VipTicketCreated` event emitted; vip-status
  endpoint reports progress.
- `events.test.ts` updated to the 25-event catalog.
- Full suite `pnpm vitest run` + `npx turbo run typecheck` green.
- Evidence written to `work-logs/phase-4/verification.json`.

## 8. Results

- **Tests**: 292/292 across 36 files (Task 18 baseline 275 + 17 new:
  heatmap 4, wear 5, vip 8). `npx turbo run typecheck` 5/5.
- **New API surface** (live-verified on :3001):
  - `GET /api/v1/discovery/heatmap` - public aggregate grid (200).
  - `GET /api/v1/wear/orders/active` + `POST /api/v1/wear/orders/reorder` -
    auth, payload < 500 bytes (401 without token).
  - `GET /api/v1/support/vip-status` + `POST /api/v1/support/ticket` -
    auth (401 without token).
- **Frontends**:
  - Admin ops console (new first page) - https://3003-519060a9af2c6382.monkeycode-ai.live/heatmap
  - Consumer profile VIP badge + Priority Support ticket form.
- **Event catalog**: 25 (added `HeatmapQueried`, `WearOrderListed`,
  `VipTicketCreated`).
- **Evidence**: `work-logs/phase-4/verification.json` (GO, 19/19 compliance).
