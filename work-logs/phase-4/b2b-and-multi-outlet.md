# Phase 4 Initiation: B2B Catering (W12) & Multi-Outlet Dashboard (V15)

- Task: 18 (Phase 4 Initiation)
- Persona: UI/UX Agent (active) + EOS Layer 1 (DDD)
- Status: COMPLETE

## 1. Objective

Enter Phase 4 (Multi-City & B2B Scale) with two features:

1. **W12 Catering Orders** - bulk corporate/event orders (50+ headcount) with
   advance scheduling, custom bulk pricing and line-level descriptions.
2. **V15 Multi-outlet Dashboard** - a Chain Owner (or ADMIN) aggregates orders,
   revenue and AOV across every outlet under a chain, with outlet-to-outlet
   comparison.

Both features are designed as **new bounded contexts** on EOS Layer 1: the
catering flow lives in the **ordering** context; the chain/outlet model and
aggregation live in the **vendor-ops / catalog-organization** context.

## 2. Catering Order Schema (W12)

Catering orders are bulk line-item orders flagged on the `orders` aggregate.
They bypass the standard consumer per-line quantity cap (50) and allow a
per-line `unit_price` override (custom bulk pricing) and `description`
(custom bulk description), plus order-level advance scheduling.

### Data model deltas (packages/db)

```sql
-- orders: bulk-order flags (Phase 4, W12)
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "is_catering" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "headcount" integer;
```

- `is_catering` distinguishes the bulk B2B flow from the standard
  consumer flow. Defaults `false`, so existing orders are unaffected.
- `headcount` records the event size. `NULL` for standard orders.
- Advance scheduling reuses the existing `scheduled_pickup_time` column on
  `orders` (the catering event date/time). No new timestamp column needed;
  the ordering context already persists it on the aggregate.

### API contract (ordering context)

`POST /api/v1/orders/catering` (Bearer auth)

```jsonc
{
  "restaurant_id": "a0000000-0000-4000-8000-000000000001",
  "event_date": "2026-09-01T10:30:00+05:30",
  "headcount": 150,
  "budget": 50000,
  "special_instructions": "Arrive by 9:45 AM; set up buffet counter",
  "items": [
    { "menu_item_id": "b0000000-0000-4000-8000-000000000001",
      "quantity": 100,
      "unit_price": 200,
      "description": "Extra saffron, mild spice" },
    { "menu_item_id": "b0000000-0000-4000-8000-000000000002",
      "quantity": 50 }
  ]
}
```

Rules:
- `headcount` must be an integer `>= 50` (bulk gate). Below 50 -> 400.
- Each line references a `menu_item_id` owned by the target restaurant (FK-safe
  on `order_items.menu_item_id`). `quantity` is unbounded up to 1000 (bypasses
  the standard 50 cap). `unit_price` optionally overrides the catalog price for
  negotiated bulk rates. `description` is carried on the line.
- Total = `sum(quantity * effective_unit_price)`. Budget is advisory metadata.
- The order is created as `DRAFT` with `is_catering = true`, then immediately
  transitioned to `CONFIRMED` by a **simulated separate catering-confirmation
  flow** (the B2B desk approves the quote) - this keeps the consumer
  fulfillment state machine (which has no DRAFT transition) untouched.
- Emits a new `CateringOrderCreated` domain event (event catalog grows 21 -> 22).

### Work-log / schema note

`order_items` keeps the existing shape (name, base_price, quantity,
customizations). Catering custom descriptions ride the `description` field on
the API contract and are echoed into the line `name`/`base_price` snapshot so
the kitchen display shows the negotiated line without a schema migration on
`order_items`.

## 3. Chain / Outlet Data Model (V15)

A **Chain** is a group of restaurants (outlets) under one owner. Outlets are
existing `restaurants` rows pointed at their chain via a nullable FK.

### Data model deltas (packages/db)

```sql
CREATE TABLE IF NOT EXISTS "chains" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"       text NOT NULL,
  "owner_id"   uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "chain_id" uuid;

-- FKs + indexes
ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_chain_id_chains_id_fk"
  FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id");
ALTER TABLE "chains"
  ADD CONSTRAINT "chains_owner_id_users_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");
CREATE INDEX IF NOT EXISTS "chains_owner_idx"       ON "chains" ("owner_id");
CREATE INDEX IF NOT EXISTS "restaurants_chain_idx"  ON "restaurants" ("chain_id");
```

- `chains.owner_id` -> `users.id` (the Chain Owner). `ADMIN`/`SUPER_ADMIN`
  are allowed system-wide.
- `restaurants.chain_id` is **nullable**: an independent restaurant simply has
  no chain. Multi-outlet brands attach each outlet row to the chain.

### Repository (vendor-ops context)

`chainRepository.ts` (interface + memory impl) exposes:
- `getById(chainId)` -> ChainDTO
- `getByOwner(ownerId)` -> ChainDTO[]
- `getAll()` (ADMIN scope)
- `getOutletIdsByChain(chainId)` -> string[]
- `getOutletChainId(restaurantId)` -> chainId | null

## 4. Aggregation Queries (V15)

The multi-outlet dashboard aggregates per-outlet, then combines:

```
for each outlet in chain:
    orders      = orderRepo.getByRestaurant(outletId)
    eligible    = orders where status in {CONFIRMED..SETTLED}   (reuses the
                  V08 ELIGIBLE_INSIGHT_STATUSES set so DRAFT/payments-failed
                  carts never pollute totals)
    order_count = eligible.length
    revenue     = round2(sum(eligible.total_amount))
    aov         = round2(revenue / order_count) or 0

total_orders     = sum(outlet.order_count)
total_revenue    = round2(sum(outlet.revenue))
combined_aov     = round2(total_revenue / total_orders) or 0
outlet.share     = round2(outlet.revenue / total_revenue * 100) (2dp)
```

In production this is two indexed queries (restaurants by chain_id, then
orders by restaurant_id; both indexes exist). In the offline memory model the
same shape is computed in one pass over each outlet's order list.

### API contract (vendor-ops context, strict RBAC)

`GET /api/vendor/chains` - list chains for the current user (owner; ADMIN sees
all). Returns each chain with its outlet names for the dropdown.

`GET /api/vendor/chains/:chainId/aggregate-insights` - combined totals plus a
per-outlet breakdown for the "Outlet A vs Outlet B" comparison UI:

```jsonc
{
  "chain_id": "c0000000-0000-4000-8000-000000000001",
  "chain_name": "SnakZap Mumbai Chain",
  "outlet_count": 2,
  "total_orders": 5,
  "total_revenue": 2450,
  "combined_aov": 490,
  "outlets": [
    { "restaurant_id": "a...001", "name": "Biryani House",
      "order_count": 3, "revenue": 1500, "aov": 500, "share": 61.22 },
    { "restaurant_id": "a...002", "name": "Green Bowl",
      "order_count": 2, "revenue": 950, "aov": 475, "share": 38.78 }
  ]
}
```

### RBAC (security)

- New `requireRole("VENDOR_OWNER", "ADMIN")` middleware verifies the Bearer
  JWT (401 on missing/invalid) and checks the `role` claim (403 otherwise).
- Chain access is additionally ownership-scoped: a `VENDOR_OWNER` may only
  read chains where `chains.owner_id == userId`. `ADMIN` bypasses ownership.
- A standard `VENDOR_STAFF` gets **403 Forbidden** on chain-level data.

## 5. Frontend (apps/vendor)

- **`/chain` Chain Overview**: dropdown to pick an outlet or "All Outlets";
  stat cards for orders / revenue / AOV; outlet comparison bars driven by the
  per-outlet `share` and `revenue` fields; `TealSkeleton` loaders, teal
  palette, dark theme (consistent with Phase 2/3 UI).
- **`/catering` B2B Catering form**: Date, Headcount, Budget, Special
  Instructions, and a repeatable line-item editor (menu item, quantity,
  optional unit price). Submits to `POST /api/v1/orders/catering` and shows
  the confirmed order summary.
- Both pages use a small `lib/cateringAuth.ts` helper that performs the demo
  OTP login (`send-otp` then `verify-otp` with the dev OTP) to obtain a Bearer
  token, since the chain endpoints are role-gated and catering is auth-gated.
- Demo seed (dev server only): a VENDOR_OWNER user, the "SnakZap Mumbai
  Chain", and outlets Biryani House + Green Bowl attached to it.

## 6. Verification Plan

- `apps/api/src/routes/chains.test.ts`: RBAC matrix (no token 401,
  VENDOR_STAFF 403, VENDOR_OWNER owner 200, VENDOR_OWNER non-owner 403,
  ADMIN 200); aggregation math (per-outlet + combined AOV, shares sum to
  100); non-existent chain 404; DRAFT/PAYMENT_FAILED excluded.
- `apps/api/src/routes/catering.test.ts`: headcount < 50 -> 400; 50+ creates
  order with `is_catering: true`, `headcount` set, status `CONFIRMED`; custom
  `unit_price` honored in total; quantity > 50 accepted (bypass); unknown
  restaurant 404; event emitted; unauthenticated -> 401.
- `packages/types/src/events.test.ts` updated to the 22-event catalog.
- Full suite `pnpm vitest run` + `npx turbo run typecheck` green.
- Evidence written to `work-logs/phase-4/verification.json`.

## 7. Migration Reference

- `packages/db/drizzle/0006_chain_catering.sql`
- Drizzle schema: `packages/db/src/schema/chain.ts` (new), `catalog.ts`
  (restaurants.chain_id), `ordering.ts` (orders.is_catering + headcount).

## 8. Execution Result

- **275/275 tests across 33 files** pass (`pnpm vitest run`); turbo typecheck
  5/5. 18 new Phase 4 tests (chains + catering) + updated event/schema tests.
- Live API :3001 verified: VENDOR_OWNER OTP login -> `GET /api/vendor/chains`
  200 -> `GET /api/vendor/chains/:id/aggregate-insights` 200; `POST
  /api/v1/orders/catering` 201 (is_catering true, CONFIRMED, headcount 150,
  custom pricing 100 x 200 + 50 x 180) -> aggregate now reports
  orders 1 / revenue 32220 / AOV 32220; non-owner role -> **403 live**.
- Vendor UI `/chain` and `/catering` pages live and returning 200 on :3002.
- Evidence: `work-logs/phase-4/verification.json` (verdict GO, 19/19
  compliance checks PASS).
