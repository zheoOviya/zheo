# Social Gifting Design Spec

Date: 2026-08-20
Status: Approved (brainstormed, sections 1-3 approved)
Branch: new feature branch (created from `main`)

## Purpose

Bring Snakzap's positioning closer to Snackpass by adding **Social Gifting**: a consumer can buy a specific menu item from a restaurant (with sender-chosen customizations + spice level) and gift it to anyone via a shareable link + code. The recipient claims the pre-paid item into their cart at ₹0 and picks it up. The **sender** earns the loyalty stamp/streak on fulfillment (generosity rewarded; recipient does not double-dip).

Scope is limited to gifting a **specific menu item, one item per gift**. Monetary gift balances, friends/social graph, and a social feed are deliberately out of scope (later sub-projects).

## Design Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Gift object | Specific menu item (sender-chosen customizations/spice, frozen snapshot) |
| Items per gift | Single item |
| Recipient model | Shareable gift link + 8-char code (no friends graph needed) |
| Claim flow | One-step claim into recipient's cart (login required) |
| Expiry | 90 days from creation; unfulfilled gifts expire → auto refund |
| Payment method | Razorpay gateway only (no COD for gifts) |
| Loyalty credit | Sender gets stamp/streak on fulfillment; recipient gets nothing |
| Architecture | Approach A: first-class durable `gifts` entity + reuse of Razorpay payment infra |

## Data Model

### New table `gifts` (`packages/db/src/schema/gifts.ts`, Drizzle, durable)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| sender_id | uuid FK → users | NOT NULL |
| restaurant_id | uuid FK → restaurants | NOT NULL |
| menu_item_id | uuid FK → menu_items | NOT NULL; server-side validation anchor |
| item_snapshot | jsonb | `{ name, price, image_url, dietary_tags, spice_level, customizations }` — frozen copy of what the sender configured; recipient cannot change it |
| price_paid | decimal(10,2) | item base price + sender's customization deltas, server-computed |
| message | text nullable | sender's note to recipient |
| recipient_name | text nullable | optional personalization shown on landing page |
| claim_token | text unique NOT NULL | high-entropy random, same pattern as `group_cart_token` |
| claim_code | text NOT NULL | 8-char uppercase (manual entry) |
| status | enum | `PENDING`, `ACTIVE`, `CLAIMED`, `FULFILLED`, `EXPIRED`, `REFUNDED`, `CANCELLED` |
| payment_id | uuid FK → payments nullable | set when a payment record is created |
| claimed_by | uuid FK → users nullable | |
| claimed_at | timestamptz nullable | |
| fulfilled_at | timestamptz nullable | |
| refunded_at | timestamptz nullable | |
| expires_at | timestamptz NOT NULL | `created_at + 90 days` |
| created_at / updated_at | timestamptz | |

**Status semantics:**
- `PENDING` — payment intent created, not yet paid. Gift not shareable yet.
- `ACTIVE` — Razorpay payment captured (webhook); shareable/claimable.
- `CLAIMED` — recipient claimed it into their cart (reserved).
- `FULFILLED` — recipient's order containing the gift was picked up.
- `EXPIRED` — unfulfilled gift past `expires_at` (sweep).
- `REFUNDED` — sender refunded (expiry refund or sender cancel).
- `CANCELLED` — sender cancelled while unpaid/paid (final terminal alongside REFUNDED where money moved).

### Schema tweaks

1. **`payments.order_id` → nullable**; add `payments.gift_id` uuid FK → gifts nullable. Invariant: exactly one of `order_id` / `gift_id` set (enforced in the payment repo/service, plus application-level checks). This keeps all money in one table and reuses idempotent webhook processing.
2. **`order_items` + `gift_id`** uuid FK → gifts nullable. The redeemed gift line is recorded in the recipient's order at base price 0.

## API Endpoints

All under `/api/v1/gifts`. Consumer app routes, existing auth + envelope middleware.

| Method + Path | Auth | Purpose / behavior |
|---|---|---|
| `POST /api/v1/gifts` | sender | Body: `{ restaurant_id, menu_item_id, customizations?, message?, recipient_name? }`. Server loads the menu item, validates restaurant match + availability, **computes price server-side** (base + customization deltas), creates gift `PENDING` + payment record (`gift_id`) + Razorpay order. Returns `{ gift, razorpay_order_id, amount }`. |
| `POST /api/v1/gifts/:id/cancel` | sender | Allowed only on `PENDING` / `ACTIVE` (never after CLAIMED/FULFILLED). Unpaid (`PENDING`) → `CANCELLED`. Paid (`ACTIVE`) → initiate Razorpay **refund**; status → `REFUNDED` **only after the Razorpay refund webhook confirms** (see Refund flow). |
| `GET /api/v1/gifts/mine` | sender | Sender's sent gifts, newest first, with status + share link + code. Powers Profile → My Gifts. |
| `GET /api/v1/gifts/t/:token` | public | Gift landing data: item snapshot, restaurant, masked sender (name or phone), message, recipient_name, status, expires_at, claimed_at, fulfilled_at. No auth. |
| `POST /api/v1/gifts/t/:token/claim` | recipient | Validates: gift is `ACTIVE`, not expired, **not a self-gift** (claimed_by != sender_id), not already claimed. On success: gift → `CLAIMED`, `claimed_by` set, returns gift + snapshot so client adds a ₹0 cart line. |
| `POST /api/v1/gifts/t/:token/release` | recipient | Allowed only when the gift is `CLAIMED` by this user **and the recipient has no confirmed order containing it** (i.e., only before order confirmation/fulfillment). Gift → `ACTIVE` (re-claimable). Used by cart-remove and by order-cancel. |
| Razorpay webhook (existing `/api/v1/payments/webhook`) | — | Extended to route by `payment.gift_id`: on `CAPTURED` → gift `ACTIVE` + emit `GiftPaid`; on `FAILED` → gift stays `PENDING` (retryable). Refund webhook → gift `REFUNDED` (see Refund flow). |

## Flows

### A. Sender: create → pay → share

1. Restaurant menu page: each item has a **Gift action** (gift icon beside add-to-cart).
2. `GiftModal`: item summary with sender-chosen customizations + spice level, optional recipient name + message, amount shown, "Pay & Send".
3. `POST /api/v1/gifts` creates gift `PENDING` + payment record + Razorpay order.
4. Razorpay checkout (existing consumer flow) → webhook capture → gift `ACTIVE` + `GiftPaid` event.
5. Success screen: gift link (`/gift/[token]`) + 8-char code, **Share** via Web Share API (WhatsApp/insta) + copy link + copy code.
6. Payment failure: gift stays `PENDING`. Sender can **Retry payment** (re-initiate Razorpay order) or **Cancel** from Profile → My Gifts / success screen.

### B. Recipient: claim → checkout → pickup

1. Opens link → `GET /api/v1/gifts/t/:token` → landing page (gift-card aesthetic).
2. **Claim button is disabled** (with a status message) when the gift is `EXPIRED`, `FULFILLED`, `REFUNDED`, `CANCELLED`, or already `CLAIMED` by someone else.
3. Login gate (phone OTP); on return the claim page resumes.
4. `POST /api/v1/gifts/t/:token/claim` → gift `CLAIMED`, claimed_by set. Client adds the item to cart at **₹0**, fixed snapshot (customizations locked), with a gift badge.
5. Normal checkout: recipient pays only their own items; the gift line contributes subtotal ₹0. `order_items.gift_id` records the redemption. **Order creation validates each gift line**: the gift must be `CLAIMED` by this user and not `EXPIRED`/`REFUNDED`/`CANCELLED`; otherwise the order is rejected (client shows "gift no longer available").
6. Cart remove of the gift line → `POST /release` → gift back to `ACTIVE` (never lost by cart churn).
7. Order cancel containing a gift line → same release path → `ACTIVE`.
8. Recipient's order is picked up (existing QR/OTP pickup, unchanged). The **fulfillment service** (on marking an order `PICKED_UP`) checks for gift lines and, for each, marks the gift `FULFILLED` (`fulfilled_at`) and emits `GiftFulfilled`.

### C. Loyalty: sender gets the credit

- The **fulfillment service**, when marking an order `PICKED_UP`, checks `order_items` for `gift_id` lines, marks each gift `FULFILLED`, and emits a `GiftFulfilled` event.
- Loyalty service handler increments the **sender's** stamp card / streak for that restaurant (same `incrementStamp` path as `onOrderPickedUp`, but against `sender_id`, not the order user).
- Recipient gets no credit for the gift line (avoids double-dip with their own paid items).

### D. Expiry + refund (90-day)

- **Daily sweep** (`GiftExpirySweep`, a boot-time periodic interval consistent with existing sweeps): gifts `ACTIVE` or `CLAIMED` whose `expires_at` passed → `EXPIRED`. (CLAIMED past expiry is treated as unfulfilled → refund sender too.)
- Refund step: for each `EXPIRED` paid gift, submit a Razorpay **refund**; status → `REFUNDED` **only after the Razorpay refund webhook confirms** (idempotent, consistent with Razorpay). Notification to sender via existing notification outbox.
- Sender cancel before claim (paid): same refund path.

**Refund flow (unified, webhook-driven):** cancel/expiry → submit Razorpay refund request → Razorpay refund webhook → mark payment `REFUNDED` + gift `REFUNDED` + `refunded_at` → notify sender. Refunds are idempotent per gift.

## Key Invariants

- Gift price is always server-computed from the menu item + sender customizations; client never supplies a price.
- The ₹0 claim always derives from the sender's paid snapshot; the recipient is never charged.
- A gift fulfills exactly once (status machine locks transitions).
- Expiry/refund apply only to unfulfilled gifts (`PENDING`/`ACTIVE`/`CLAIMED`).
- Self-gift claims are rejected.
- Claim requires an authenticated recipient; landing page is public.

## UI / Client Changes

| Component | File | Notes |
|---|---|---|
| Per-item Gift action | `apps/consumer/app/restaurants/[id]/page.tsx` + menu components | gift icon beside add-to-cart |
| `GiftModal` | `apps/consumer/components/GiftModal.tsx` | item summary + customizations/spice, recipient name, message, amount, Pay & Send (Razorpay) |
| `GiftSuccess` | `apps/consumer/components/GiftSuccess.tsx` | link + code + Share (Web Share API) + copy; Retry payment / Cancel on `PENDING` |
| Gift landing page | `apps/consumer/app/gift/[token]/page.tsx` | gift-card aesthetic; status-aware (disabled Claim + message for non-claimable states); login gate; claim → redirect to restaurant menu with toast |
| Profile → My Gifts | `apps/consumer/app/profile/page.tsx` (section or sub-page) | sent gifts: status, **Re-share link** (ACTIVE), **Cancel** (only `PENDING`/`ACTIVE`), Retry payment (`PENDING`) |
| Cart gift line | `apps/consumer/components/CartDrawer.tsx` | gift badge + ₹0; remove → release |

Client/state:
- `CartItem` gains `giftId?: string`; gift lines have `basePrice 0` and locked customizations.
- Server-persisted cart shape passes `gift_id` through.

## API / Service Structure

Follows the existing repo pattern (interface + Drizzle + Memory):

- `apps/api/src/routes/gifts.ts` — endpoints with zod validation on every body/param.
- `apps/api/src/repositories/giftRepository.ts` — `GiftRepository` interface + `DrizzleGiftRepository` + `MemoryGiftRepository` (tests use Memory, seeded).
- `apps/api/src/services/gift.ts` — `GiftService`: create / pay / claim / release / cancel / fulfill / expire / refund orchestration; enforces the status machine.
- `apps/api/src/services/payments.ts` — extend for the gift payment path (gift_id routing in webhook; refund submission).
- `apps/api/src/services/razorpay.ts` — add refund call if not present.
- `apps/api/src/services/loyalty.ts` — `GiftFulfilled` handler → sender stamp/streak credit.
- `apps/api/src/services/giftExpirySweep.ts` — daily sweep; wired at API boot like existing sweeps.

## Security / Hardening

- `claim_token`: high-entropy random (group-order pattern); `claim_code`: 8-char uppercase.
- Every claim/release/cancel validates status transitions (state machine locks).
- Server-side pricing always; refund idempotent per gift.
- Landing page reveals only masked sender identity.

## Testing Strategy

### API route tests (`apps/api/src/routes/gifts.test.ts`)
- Create: validation errors, restaurant mismatch, unavailable item, **server-side pricing** (client-claimed price ignored), PENDING + payment record + razorpay order creation.
- Payment webhook gift routing: CAPTURED → ACTIVE + `GiftPaid`; FAILED → stays PENDING.
- Claim: success; self-gift rejected; expired rejected; already-claimed rejected; non-ACTIVE rejected; sets claimed_by/claimed_at.
- Release: pre-confirmation only (rejected once a confirmed order exists); returns to ACTIVE.
- Cancel: PENDING → CANCELLED; ACTIVE → refund requested; not allowed after CLAIMED.
- Refund webhook: REFUNDED + refunded_at.
- Sweep: ACTIVE/CLAIMED past expiry → EXPIRED → refund requested → webhook → REFUNDED.
- Loyalty: pickup of an order with a gift line credits the **sender's** stamp card (and not the recipient's / order user's).

### Repo tests
- Drizzle schema (gifts table) + Memory repo (existing pattern).

### Consumer tests
- `GiftModal`: payload built correctly (customizations/spice/message), validation, opens Razorpay.
- Gift landing page: renders each status state; Claim disabled for EXPIRED/FULFILLED/REFUNDED/CANCELLED/claimed-by-other; login gate.
- Cart gift line: ₹0 + badge; remove triggers release.
- Profile → My Gifts: statuses, Re-share (ACTIVE), Cancel visibility (PENDING/ACTIVE only).

### E2E (Playwright, later/optional)
- Full link flow: sender creates + pays → recipient opens link → claims → checks out (pays own items) → pickup → sender sees stamp credit.
- **Sender cancels before claim → refund processed → recipient link shows CANCELLED state.**

## Out of Scope (future sub-projects)

- Monetary gift balances / gift cards
- Friends graph + social feed (Venmo-like)
- In-app messaging
- Push notifications
- Meal-plan sync
- Vendor-configured loyalty
