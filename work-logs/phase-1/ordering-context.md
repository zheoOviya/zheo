# Work-Log: Phase 1 - Ordering Context (Cart, Customizations & Pricing)
**Date**: 2026-08-04
**Feature ID**: P1-005-ORDERING-CONTEXT
**Status**: COMPLETE

## Objective
Build the core ordering flow: cart management, customization selection, transparent price breakdown, and order creation (DRAFT -> PAYMENT_PENDING). Features from PRD Phase 1: O06 Customizations, O10 Price Breakdown, O08 Quick Reorder.

## Pricing Strategy (PRD Section 1, O10)
| Component | Rate | Notes |
|-----------|------|-------|
| Item Subtotal | sum(base price + customization deltas) | Per item, configurable additions |
| GST (Food) | 5% on food items | Applied to item subtotal |
| GST (Packaging) | 18% on packaging fee | |
| Packaging Fee | Rs 10 flat per order | Configurable |
| **Commission (Vendor Settlement)** | 0% if total <= Rs 200, 8% if > Rs 200 | Calculated now for settlement event later; NOT shown to consumer |

User-facing breakdown: Subtotal + GST (Food) + Packaging Fee + GST (Packaging) = Grand Total.
Vendor backend field: `commission_amount` calculated from `total_amount` using the tiered rule.

## API Endpoints (ordering context, base `/api/v1`)
| Endpoint | Purpose | Events Emitted |
|----------|---------|---------------|
| `POST /orders` | Create order in DRAFT status | `OrderCreated` (EOS envelope) |
| `POST /orders/reorder` | Quick reorder from prior order | `OrderCreated` (EOS envelope) |

## Order Creation Flow
1. Client sends `{ restaurant_id, items: [{ menu_item_id, quantity, customizations[] }], scheduled_pickup_time? }`
2. Server validates restaurant active, items available
3. `calculatePriceBreakdown()` computes item totals, GST, packaging, commission
4. Order record created with status DRAFT, total_amount, pickup_otp=null
5. `OrderCreated` event emitted to the Event Catalog with full order payload

## Cart State Management (Zustand)
- Store: `useCartStore` with `items: CartItem[]`, `restaurantId`, `addItem`, `removeItem`, `updateQuantity`, `clear`, `subtotal`
- CartItem: `{ menuItemId, name, basePrice, quantity, customizations: { name, price_delta }[], totalPrice }`
- Cart is client-side only (Phase 3 persistence deferred)

## Customization Picker (3-tap rule)
- Tap 1: Select item from menu
- Tap 2: Choose customizations in picker (e.g., Extra Cheese +Rs 30, No Onion +Rs 0)
- Tap 3: Confirm -> item added to cart with calculated price
Shows live item price as customizations are toggled.

## Target Files
Backend:
- `apps/api/src/services/pricing.ts`
- `apps/api/src/lib/eventBus.ts`
- `apps/api/src/repositories/orderRepository.ts`
- `apps/api/src/routes/orders.ts` + `.test.ts`

Frontend:
- `apps/consumer/lib/store.ts` (Zustand cart)
- `apps/consumer/components/CartDrawer.tsx`
- `apps/consumer/components/CustomizationPicker.tsx`
- `apps/consumer/components/PriceBreakdown.tsx`

## Verification Criteria (ECS)
- [x] `calculatePriceBreakdown` unit-tested at <=200, exactly 200, >200, with customizations, GST+packaging
- [x] POST /orders creates DRAFT order, emits OrderCreated event, validates items
- [x] POST /orders/reorder copies items from old order
- [x] Cart Zustand store: add/remove/quantity/subtotal correctness
- [x] Customization picker calculates live item total
- [x] Vitest suite (pricing + ordering routes) passes (79 tests, 12 files)
- [x] verification.json generated
- [x] order_items DB table added (10 cols, 2 FKs, 2 indexes)
- [x] OrderItem Zod schema added to domain types
- [x] Drizzle migration 0001 generated
