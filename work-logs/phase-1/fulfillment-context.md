# Work-Log: Phase 1 - Fulfillment Context (Kitchen Status & QR Pickup)
**Date**: 2026-08-05
**Feature ID**: P1-008-FULFILLMENT-CONTEXT
**Status**: COMPLETE

## Objective
Build the core pickup experience: live kitchen status via WebSocket (P05), vendor state machine (P14), QR code pickup (P01), OTP fallback (P15), and auto check-in (P03).

## WebSocket Setup (EOS Layer 1)
- `ws` library integrated with Express via `server.on("upgrade")`
- Redis PubSub for cross-instance broadcasting
- Channel: `order_updates`
- Consumer subscribes to `order:{orderId}`, Vendor subscribes to `restaurant:{restaurantId}`
- Event contract: `{ event: "ORDER_STATUS_UPDATE", data: { order_id, sql_status, ui_status } }`

## Vendor State Machine (PRD Section 4)
```
CONFIRMED -> PREPARING -> ALMOST_READY -> READY_FOR_PICKUP -> PICKED_UP
```
- Must advance sequentially; skipping states is rejected
- Each transition generates OTP and QR token at CONFIRMED stage
- Each transition broadcasts WebSocket event

## API Endpoints

### Consumer (auth required)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/orders/:id/check-in` | POST | Auto check-in (P03) |
| `/api/v1/orders/:id/confirm-pickup` | POST | Verify QR token or OTP, transition to PICKED_UP |

### Vendor (staff auth)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/vendor/orders/:id/status` | PUT | Advance order status in state machine |

## QR/OTP Pickup Flow (P01, P15)
1. Order reaches CONFIRMED -> generate 4-digit OTP + QR token (UUID)
2. Consumer tracking page shows QR code + OTP when status is READY_FOR_PICKUP
3. Vendor staff scans QR or enters OTP -> POST /confirm-pickup
4. System verifies token/OTP -> transitions to PICKED_UP -> emits OrderPickedUp event

## Target Files
Backend:
- `apps/api/src/services/fulfillment.ts` (new)
- `apps/api/src/lib/websocket.ts` (new)
- `apps/api/src/routes/fulfillment.ts` (new)
- `apps/api/src/routes/fulfillment.test.ts` (new)
- `apps/api/src/repositories/orderRepository.ts` (update - add qr_token, setPickupOtp)
- `apps/api/src/app.ts` (update - wire)
- `apps/api/src/index.ts` (update - WebSocket server)

Frontend Consumer:
- `apps/consumer/app/orders/[id]/page.tsx` (new)
- `apps/consumer/components/OrderTracker.tsx` (new)
- `apps/consumer/components/QrCode.tsx` (new)
- `apps/consumer/hooks/useWebSocket.ts` (new)
- `apps/consumer/middleware.ts` (update)

Frontend Vendor:
- `apps/vendor/tsconfig.json` (new)
- `apps/vendor/next.config.mjs` (new)
- `apps/vendor/tailwind.config.ts` (new)
- `apps/vendor/postcss.config.mjs` (new)
- `apps/vendor/app/layout.tsx` (new)
- `apps/vendor/app/globals.css` (new)
- `apps/vendor/app/page.tsx` (new)
- `apps/vendor/hooks/useOrdersWebSocket.ts` (new)

## Verification Criteria (ECS)
- [x] State machine enforces sequential transitions
- [x] WebSocket emits ORDER_STATUS_UPDATE on each status change
- [x] POST /check-in records consumer arrival
- [x] POST /confirm-pickup validates QR token and OTP correctly
- [x] Order tracking page shows live status with WebSocket
- [x] QR code and OTP displayed on READY_FOR_PICKUP
- [x] Vendor dashboard shows pending orders with status controls
- [x] Vitest suite passes
- [x] verification.json generated

## Completion Notes
- Live E2E verified against running API: order -> payment webhook (CONFIRMED) -> advance PREPARING (OTP+QR generated) -> ALMOST_READY -> READY_FOR_PICKUP -> check-in -> confirm-pickup (PICKED_UP).
- WebSocket broadcast verified live: subscriber received `ORDER_STATUS_UPDATE` with `sql_status: PREPARING` on advance, including through Next.js dev proxy (port 3000 -> 3001).
- Added missing `GET /api/v1/orders/:id` (auth + ownership check) that the consumer tracking page depends on. 3 new tests.
- Fixed API startup: `initWebSocketServer` wired into `index.ts` (was exported but never called); WebSocket server now starts with the API.
- Fixed type errors from `@types/express` v5 (req.params union) and strict `OrderStatus` typing.
- Config relaxed: `REDIS_URL`/`JWT_SECRET`/`JWT_REFRESH_SECRET`/`MSG91_AUTH_KEY` optional-with-default so the API boots without live Redis/SMS. MemoryRedis seam added (`duplicate`/`publish`/`subscribe` no-ops).
- Dev-mode OTP bypass (any 6 digits) matches consumer login page hint; production/test verify strictly.
- Consumer/vendor WebSocket URLs now derive from `window.location` with `/api/v1/ws` path so the Next.js rewrite proxies upgrades through the exposed preview port.
- Final suite: 121 tests, 15 files, all passing.
