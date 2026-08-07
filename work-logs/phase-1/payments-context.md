# Work-Log: Phase 1 - Payments Context (Razorpay Integration & Webhook Idempotency)
**Date**: 2026-08-05
**Feature ID**: P1-007-PAYMENTS-CONTEXT
**Status**: COMPLETE

## Objective
Build the payment execution and verification layer. Implement Razorpay order creation, webhook verification with signature validation, idempotency via DB transaction locks, and the checkout-to-payment state machine (DRAFT -> PAYMENT_PENDING -> CONFIRMED/PAYMENT_FAILED).

## Payment State Machine (PRD Section 4)
```
DRAFT -> PAYMENT_PENDING (after Razorpay order created)
PAYMENT_PENDING -> CONFIRMED (on payment.captured webhook)
PAYMENT_PENDING -> PAYMENT_FAILED (on payment.failed webhook)
```

## Razorpay Integration (PRD Phase 1, O04 Pre-paid Button)
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/v1/payments/create-order` | POST | JWT Bearer | Creates Razorpay order, returns razorpay_order_id |
| `/api/v1/payments/webhook` | POST | X-Razorpay-Signature | Webhook receiver - idempotent, signature-verified |

## Idempotency Strategy (PRD Section 7)
- Webhook payload contains `razorpay_payment_id`
- On receipt: check payments table for existing record with same `razorpay_payment_id`
- Found: return 200 OK, no side effects (idempotent)
- Not found: create payment record, update order status, emit event
- Production: `SELECT ... FOR UPDATE` on orders table for row-level locking
- Offline/Memory: check-then-insert with Map-backed repo

## Event Emissions (EOS Layer 1.2)
| Event | Trigger | Payload |
|-------|---------|---------|
| `PaymentSucceeded` | payment.captured webhook | { order_id, payment_id, amount } |
| `PaymentFailed` | payment.failed webhook | { order_id, payment_id, reason } |

## Target Files
Backend:
- `apps/api/src/services/razorpay.ts` (new - Razorpay API client with offline mock)
- `apps/api/src/repositories/paymentRepository.ts` (new)
- `apps/api/src/services/payments.ts` (new - orchestration service)
- `apps/api/src/routes/payments.ts` (new - 2 endpoints)
- `apps/api/src/routes/payments.test.ts` (new)
- `apps/api/src/app.ts` (update - wire payments router)

Frontend:
- `apps/consumer/app/checkout/page.tsx` (update - Place Pickup Order button)
- `apps/consumer/lib/api.ts` (update - add payment API calls)

## Verification Criteria (ECS)
- [x] POST /payments/create-order creates Razorpay order, updates order to PAYMENT_PENDING
- [x] POST /payments/webhook verifies X-Razorpay-Signature
- [x] Webhook idempotency: duplicate payload returns 200, order status changes only once
- [x] payment.captured webhook -> CONFIRMED + PaymentSucceeded event
- [x] payment.failed webhook -> PAYMENT_FAILED + PaymentFailed event
- [x] Webhook with invalid signature -> 401
- [x] Checkout page: Place Pickup Order button, simulated Razorpay flow
- [x] Vitest suite passes (102 tests, 14 files)
- [x] verification.json generated
