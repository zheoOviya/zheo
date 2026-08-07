# P1-009 Vendor Ops Context: Daily Settlements & Menu Photo Upload

- Feature: V11 Daily Settlement Report, V13 Photo Upload for Menu Items, EOS Layer 2 Audit Trail
- Context: SnakZap - Pickup-first food ordering platform (vendor-facing operations)
- Date: 2026-08-05

## Scope

Two vendor-facing backend capabilities plus the audit trail that records every
vendor action:

1. **V11 Daily Settlement Report** - per-restaurant daily payout PDF.
2. **V13 Photo Upload for Menu Items** - multipart image upload -> object storage -> CDN URL.
3. **EOS Layer 2 Audit Trail** - every vendor action written to `audit_logs`.

## Settlement Calculation Engine (V11)

PRD commission rules applied **per order** using the order's `total_amount`
(the value already includes GST on food + packaging, matching the O10 price
breakdown produced at ordering time):

```
commission = total_amount <= 200 ? 0 : round(total_amount * 0.08)
```

Taxes are recomputed deterministically from the persisted `order_items`
(never trusted from the client):

```
food_subtotal   = sum(item.item_subtotal)          // (base + customizations) * qty
item_count      = sum(item.quantity)
packaging_fee   = item_count * 10                  // Rs 10/item (PRICING.packagingFeePerItem)
gst_food        = round(food_subtotal * 0.05)      // PRICING.gstFood
gst_packaging   = round(packaging_fee * 0.18)      // PRICING.gstPackaging
taxes           = round(gst_food + gst_packaging)
```

Final payout per order:

```
payout = round(total_amount - commission - taxes)
```

The constants (`PRICING.commissionThreshold = 200`, `PRICING.commissionRateHigh
= 0.08`, `PRICING.commissionRateLow = 0`) are reused from
`apps/api/src/services/pricing.ts` so the settlement engine can never diverge
from the checkout math. Verified with unit tests: a Rs 150 order pays 0%
commission; a Rs 500 order pays Rs 40 (8%).

### Daily window

Orders eligible for settlement are those with status `PICKED_UP` or `SETTLED`
whose `created_at` falls inside the target UTC day (`[startOfDay, startOfNextDay)`).
The `PUT /api/vendor/settlements/today` endpoint settles the **previous day**
(orders created yesterday), which is the operational norm - you settle after
the day has fully closed.

## PDF Generation Strategy

Library: **pdfkit** (installed as `pdfkit@0.19.1`). Chosen over puppeteer
because:

- No headless browser dependency (lighter, faster, test-friendly).
- Deterministic output suitable for receipts/invoices (structured layout, not
  pixel-perfect web page rendering).
- Pure streaming - we collect chunks into a `Buffer` and stream it straight to
  the HTTP response.

Layout (`apps/api/src/services/pdfGenerator.ts`):

```
SnakZap - Daily Settlement Report
Restaurant: <name>            Period: <date>
------------------------------------------------
Order ID            Order Value  Commission  Tax   Payout
<order id short>    Rs X         Rs Y        Rs Z  Rs W
------------------------------------------------
Totals:  N orders   Rs ...       Rs ...      Rs ..  Rs ...
```

The generator returns a `Buffer`; the route sets `Content-Type:
application/pdf` and `Content-Disposition: attachment;
filename="settlement-<date>.pdf"`.

## Cloud Storage Integration for Menu Photos (V13)

`apps/api/src/services/imageStorage.ts` defines a small `ImageStorage`
interface so the storage backend is swappable:

```ts
interface ImageStorage {
  upload(buffer: Buffer, contentType: string, key: string): Promise<string>;
}
```

- **`S3ImageStorage`** - real implementation using `@aws-sdk/client-s3`
  (`PutObjectCommand`). The key is namespaced per item:
  `menu/<restaurant_id>/<item_id>/<uuid>.<ext>`. The returned CDN URL is
  `https://<bucket>.s3.<region>.amazonaws.com/<key>` unless
  `S3_CDN_BASE_URL` is configured (CloudFront-style prefix).
- **`MockImageStorage`** - used when `S3_BUCKET`/`S3_ACCESS_KEY_ID` are
  missing (current dev/test environment). It returns a deterministic
  `https://cdn.snakzap.in/mock/<key>` URL and keeps the buffer in memory so
  tests can assert the upload path without hitting AWS.
- `createImageStorage()` picks the backend at runtime from config - the route
  code is identical either way, so wiring in real S3 is a config change only.

`POST /api/vendor/menu/:itemId/upload-photo` accepts `multipart/form-data`
(`multer` memory storage, single field `photo`, `image/*` mime only), uploads
through the storage service, persists the returned CDN URL to
`menu_items.image_url` (new column, migration `0002_vendor_ops.sql`), and
returns `{ image_url }`.

## Audit Trail (EOS Layer 2)

New `MemoryAuditRepository` + `logAudit(actorId, action, metadata)` helper
writes into the `audit_logs` table (schema already existed in
`packages/db/src/schema/identity.ts`). Every vendor mutation records:

| action | metadata |
|---|---|
| `settlement_downloaded` | restaurant_id, period, order_count, net_payout |
| `menu_photo_uploaded` | menu_item_id, image_url, content_type, size_bytes |
| `menu_updated` | menu_item_id, changed fields (price/is_available) |

The actor is resolved from the optional JWT (`res.locals.userId`) and falls
back to a system/vendor id in the dev flow where vendor routes are
unauthenticated (consistent with the existing `/api/vendor/*` routes).

## API Surface

Mounted in `apps/api/src/app.ts` on the existing `/api/vendor` prefix:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vendor/menu?restaurant_id=` | list menu items incl. `image_url` |
| PUT | `/api/vendor/menu/:itemId` | update `price` / `is_available` (audited) |
| POST | `/api/vendor/menu/:itemId/upload-photo` | multipart photo upload (audited) |
| GET | `/api/vendor/settlements/summary?restaurant_id=` | JSON settlement summary (previous day) |
| PUT | `/api/vendor/settlements/today?restaurant_id=` | download PDF stream (audited) |

## Vendor Dashboard UI (UI/UX Agent)

- **Settlements page** (`apps/vendor/app/settlements/page.tsx`): summary card
  (Total Orders, Total Commission, Net Payout) with a Teal-shimmer skeleton
  while loading, and a "Download PDF Report" button.
- **Menu Management page** (`apps/vendor/app/menu/page.tsx`): list of menu
  items with price/dietary chips and an "Upload Photo" button per item that
  opens a file picker; shows a Teal-shimmer skeleton while uploading and then
  the uploaded thumbnail + CDN URL.
- Shared `VendorNav` links Dashboard / Settlements / Menu Management.

## Verification

- `apps/api/src/services/settlement.test.ts` - pure calculation tests
  (0% @ Rs 150, 8% @ Rs 500, payout math, previous-day window filtering).
- `apps/api/src/routes/vendorOps.test.ts` - route tests: PDF stream returned
  with `application/pdf`, upload returns a CDN URL and persists to the menu
  item, menu update is audited, audit log rows written.
- `work-logs/phase-1/verification.json` updated to P1-009 with evidence.

## Status

COMPLETE (2026-08-05). All criteria met and verified live:

- Settlement calc tests pass (0% @ Rs 200 threshold, 8% @ Rs 500, payout math,
  previous-day window, `generateDailySettlement` orchestration) - 10 tests.
- PDF route returns a valid PDF stream (`Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="settlement-2026-08-04.pdf"`,
  body begins `%PDF-1.3`) - verified live via curl.
- Photo upload persists `image_url` and returns a mock CDN URL - verified live
  (menu listing then returns the URL). Rejects non-image mime and unknown items.
- Audit rows written for `settlement_downloaded`, `menu_photo_uploaded`,
  `menu_updated` - route tests assert metadata.
- Full suite green: 141/141 tests across 17 files; `tsc --noEmit` clean on
  api, consumer and vendor.
- Vendor UI (Settlements page + Menu Management page + shared VendorNav) serves
  200 on all routes; consumer app unaffected.

Note: `pnpm typecheck` at the workspace root (turbo) also compiles
`apps/admin`, an untracked placeholder with no tsconfig - its aggregate run
reports pre-existing JSX errors inherited from the root tsconfig (no `--jsx`)
and is unrelated to this task. The three real packages are individually clean.
