# P2-002 Vendor Tools Suite - GST Export, Promotions & Bulk Menu Edit

- Features: V12 GST Compliance, V09 Promotions Builder, V14 Bulk Menu Edit
- Context: SnakZap - Vendor Ops (vendor retention phase 2)
- Date: 2026-08-05

## Scope

Three vendor-facing tools to make SnakZap sticky for restaurants:

1. **V12 GST Compliance Export** - GSTR-1 ready CSV download per month.
2. **V09 Promotions Builder** - create promotions, list active ones.
3. **V14 Bulk Menu Edit** - Excel-like grid, atomic save-all in one DB transaction.

All routes live in the vendor ops context (`/api/vendor`) with EOS Layer 2 audit
trail entries and EOS Layer 1 DDD boundaries (new `promotions` bounded context).

## GST CSV Export Strategy (V12)

`GET /api/vendor/gst-export?month=YYYY-MM&restaurant_id=`

### Month window

`month` must match `^\d{4}-(0[1-9]|1[0-2])$`. The window is the calendar month
`[start, end)` over UTC boundaries:

```
start = Date.UTC(year, month-1, 1)
end   = Date.UTC(year, month, 1)
```

Orders are fetched with `getSettlableOrdersByRestaurant` which only returns
`PICKED_UP` and `SETTLED` orders in `[from, to)` - unpaid/draft/cancelled
orders never appear on a tax return. Sorted ascending by `created_at` so
invoice numbers run sequentially within the month.

### GSTR-1 columns

| Column | Source |
|---|---|
| `Invoice No` | `INV-YYYYMM-NNNN` (sequential per month) |
| `GSTIN` | `restaurants.gst_number` (new on `RestaurantDTO`), deterministic mock fallback |
| `Date` | `created_at` `YYYY-MM-DD` |
| `Taxable Value` | food subtotal (GST-exclusive) recomputed from order items |
| `CGST 2.5%` | `round(taxable * 0.025)` |
| `SGST 2.5%` | `round(taxable * 0.025)` |

CGST/SGST 2.5% each == the 5% food GST in the pricing model. Packaging GST
(18% = 9% + 9%) is computed in `computeTaxes` but is NOT a column in this
spec; a full GSTR-1 would emit a second HSN-rate line, which is a documented
follow-up. Values are always recomputed server-side from persisted order
items - never from client input.

CSV escaping: fields are quoted when they contain `,`, `"` or `\n`; embedded
quotes are doubled (RFC 4180). Response is streamed with
`Content-Type: text/csv; charset=utf-8` and
`Content-Disposition: attachment; filename="gstr1-YYYY-MM.csv"`.

## Promotions Schema (V09)

`repositories/promotionRepository.ts` - new promotions bounded context.

| Field | Type | Validation |
|---|---|---|
| `id` | uuid | - |
| `title` | string | 1..120 chars |
| `discount_type` | `FLAT` \| `PERCENTAGE` | enum |
| `value` | number | FLAT: 1..100000; PERCENTAGE: 0 < value <= 100 |
| `valid_until` | ISO datetime | parseable date; expired promos are excluded from active list |
| `is_active` | boolean | default true |
| `created_at` | ISO datetime | - |

- `POST /api/vendor/promotions` creates a promo and audits `promotion_created`.
- `GET /api/vendor/promotions` lists only **active** promos
  (`is_active && valid_until >= now`), newest first.
- Expired promotions are retained but never surface as active.

## Bulk Menu Update Transaction Logic (V14)

`PUT /api/vendor/menu/bulk` (registered BEFORE `PUT /api/vendor/menu/:itemId`
so Express never treats `bulk` as an `:itemId`).

Body: `{ items: [{ item_id, price?, is_available?, description? }] }`
(1..200 rows, at least one patchable field per row).

### Atomicity contract

`CatalogRepository.bulkUpdateMenuItems(restaurantId, items)` is
**all-or-nothing**:

1. **Validate phase** - every `item_id` must resolve to a menu item owned by
   `restaurant_id`. On the first miss it throws `MenuBulkUpdateError(itemId)`.
2. **Apply phase** - only when validation passes 100% are the updates written.

Memory implementation: validate-all then apply-all (no partial writes).

Drizzle implementation: the whole sequence runs inside `db.transaction()`; any
error aborts the transaction and Postgres rolls back every statement. The
memory path mirrors this so the test suite proves the rollback guarantee
without a live DB.

Route maps `MenuBulkUpdateError` -> `400 VALIDATION_ERROR` naming the offending
row, audits `menu_bulk_updated` with the row count, and returns the updated
items. Because validation happens before any write, an invalid item in the
array means **zero** items change - asserted directly in tests.

### `description` column

The bulk grid edits `description`, so `menu_items` gains a nullable
`description text` column (migration `0004_vendor_tools.sql`). Added to
`MenuItemDTO`, the seeds, and `updateMenuItem`.

## Vendor Dashboard UI (UI/UX Agent)

- **GST page** (`apps/vendor/app/gst/page.tsx`): month picker
  (`<input type="month">`, defaults to current month) + "Download GST Report
  (CSV)" button that streams the CSV blob to the browser.
- **Promotions page** (`apps/vendor/app/promotions/page.tsx`): create form
  (title, FLAT/PERCENTAGE select, value, valid-until date) and a Teal list of
  active promotions.
- **Bulk Menu Edit page** (`apps/vendor/app/menu/bulk/page.tsx`): editable
  grid (price input, availability toggle, description input per row) +
  "Save All Changes" -> `PUT /api/vendor/menu/bulk`. Teal-shimmer skeleton
  while the grid streams in and while saving.
- Shared `VendorNav` gains GST, Promotions and Bulk Menu links (wider
  `max-w-5xl` container to fit).

## Verification

- `routes/vendorTools.test.ts` (9 tests):
  - GST export streams a GSTR-1 CSV with exact header, sequential invoice
    numbers (`INV-2026-08-0001`), correct taxable/CGST/SGST values
    (220 -> 5.50/5.50, 440 -> 11.00/11.00), only PICKED_UP/SETTLED orders, only
    the requested month, correct Content-Type/Disposition; empty month -> header
    only; invalid `month` -> 400.
  - Promotions: create + list active, expired promos excluded,
    PERCENTAGE > 100 -> 400.
  - Bulk edit: valid batch updates every row (price/availability/description),
    batch containing an invalid `item_id` -> 400 and **zero** rows changed
    (transaction rollback, asserted via unchanged menu + no audit entry),
    cross-restaurant item rejected.
- `services/gstExport.test.ts` (8 tests): month window edges, GSTIN fallback
  determinism, invoice numbering, RFC 4180 CSV escaping, row math, header-only
  for empty months.
- Full suite: **172/172 tests / 21 files**, `turbo typecheck` 5/5 clean.
- Live verification (API 3001): gst-export returns the GSTR-1 header for a
  month with no settled orders (correctly excluding CONFIRMED orders) and 400
  for a bad month; promotions create + list active; bulk edit updates rows then
  a batch with an unknown `item_id` returns 400 and leaves all prices unchanged
  (verified live, no partial writes). Vendor preview (3002): `/gst`,
  `/promotions`, `/menu/bulk` all render 200.
- Evidence: `work-logs/phase-2/vendor-tools-verification.json`.

## Status

COMPLETE.
