# Product Gap Analysis — Frozen

Status: **FROZEN** as of HEAD `50e5adf` (Aug 20, 2026). This list is the locked baseline for sub-project planning. Verification method: repo inventory of `apps/api/src/routes`, `apps/api/src/services`, `apps/consumer/app`, `apps/consumer/components`.

## 1. Built Features (verified present)

| Feature | Evidence |
|---|---|
| Order ahead | `routes/orders.ts`, `services/ordering.ts`, `app/checkout` |
| Order tracking | `OrderTracker.tsx`, `services/etaService.ts` |
| Group ordering | `routes/groupOrders.ts`, `app/group-cart`, `GroupCartView.tsx` (partial — see carryovers) |
| Loyalty | `routes/loyalty.ts`, `services/loyalty.ts`, `StampCardProgress.tsx` (partial — stamps, streaks, cashback wallet; wallet not spendable) |
| Payments | `routes/payments.ts`, `services/payments.ts`, `services/razorpay.ts` (Razorpay; COD) |
| Vendor management | `routes/vendorOps.ts`, `routes/vendorApplications.ts`, `routes/posWebhook.ts`, `routes/admin.ts` |
| **Social gifting** | Delivered in PR #2 (routes `gifts.ts`, `services/gift.ts`, `giftExpirySweep.ts`, consumer GiftModal/GiftSuccess/claim page/CartDrawer/profile) |

## 2. Missing Features (gaps)

| Feature | Sub-project | Evidence of absence |
|---|---|---|
| Social gifting | Social gifting — **DONE** | (delivered; previously the top gap) |
| Meal-plan sync | Meal-plan sync | no routes/services/pages |
| Coupons redemption | Coupons redemption | no coupon/code routes/services |
| Social feed + friends graph | Social feed + friends graph | no feed/friends routes/services |
| Push notifications | Push notifications infra | `services/notifications.ts` is an in-app queue (SMS/email) only — no device push |
| In-app messaging | In-app messaging | no messaging routes/services |
| Loyalty v2 (spendable wallet) | Loyalty v2 | wallet is cashback-only, not spendable at checkout (`loyalty.ts` / retention service) |
| Pickup slots | (not in sub-project list) | route **missing** — only `pickupSlots.test.ts` exists; see `fix/pickup-slots-flaky` branch |

## 3. Sub-Projects

1. Social gifting — **EXECUTED** (spec `docs/superpowers/specs/2026-08-20-social-gifting-design.md`, plan `docs/superpowers/plans/2026-08-20-social-gifting.md`, PR #2)
2. Meal-plan sync
3. Coupons redemption
4. Loyalty v2 (wallet spendable)
5. Push notifications infra
6. Social feed + friends graph
7. In-app messaging

## 4. Execution Strategy (per sub-project)

1. Write spec (`docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`) with explicit out-of-scope section.
2. Write plan (`docs/superpowers/plans/YYYY-MM-DD-<name>.md`) as task breakdown.
3. Dispatch agents sequentially (schema → service → API → UI → testing) per the plan.
4. Verify each agent's output with regression tests (whole-repo suite green before merge).
5. Document carryovers in `.superpowers/sdd/<name>/progress.md`.

## 5. Priority

- Social gifting: **first** (Snackpass differentiating feature; was fully missing) — now done, awaiting reviewer approval on PR #2.
- Next candidates by impact: coupons redemption, loyalty v2, push notifications infra.
