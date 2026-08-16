# Vendor Multi-Restaurant Resolution

This document explains how the merchant console decides which restaurant(s) a
signed-in vendor operates, and how API/WebSocket origins are resolved in dev,
preview, and production.

## Restaurant resolution

Vendor pages no longer assume a hardcoded `RESTAURANT_ID`. Instead, after OTP
sign-in the shell loads the restaurants the vendor is authorized to operate and
stores the active restaurant in a zustand store.

### Backend

`GET /api/vendor/restaurants` is role-gated (`requireVendorOrAdmin`) and returns
every restaurant the caller may operate, using the same ownership rules as the
per-request guard in `apps/api/src/middleware/vendorAccess.ts`:

1. `ADMIN` / `SUPER_ADMIN` — all restaurants (platform scope).
2. Direct ownership — `restaurants.owner_id === userId`.
3. Restaurant-scoped membership — `user_roles` row with `scope_type = 'restaurant'`.
4. Chain-scoped membership — `user_roles` row with `scope_type = 'chain'` covering
   every outlet attached to that chain.
5. Legacy chain owner fallback — `chains.owner_id === userId`.

Response shape:

```json
{
  "success": true,
  "data": [
    {
      "id": "a0000000-0000-4000-8000-000000000001",
      "name": "Biryani House",
      "is_active": true,
      "commission_rate": 0.08,
      "chain_id": null
    }
  ],
  "error": null
}
```

On approval, the admin flow (`apps/api/src/routes/admin.ts`) creates the
restaurant and assigns either a restaurant-scoped or chain-scoped membership
row, so the list endpoint immediately reflects the new merchant.

### Frontend

- `apps/vendor/lib/api.ts` — `fetchVendorRestaurants()` calls the endpoint; every
  restaurant-scoped function now requires an explicit `restaurantId` argument
  (no more `RESTAURANT_ID` default).
- `apps/vendor/lib/store.ts` — zustand store holding `restaurants`,
  `activeRestaurantId`, and a `load()` action that selects the first active
  restaurant (or preserves the current selection when it still exists).
- `apps/vendor/hooks/useActiveRestaurant.ts` — loads the store on first use and
  exposes the active id; data pages wait for it before issuing scoped calls.
- `apps/vendor/components/AppShell.tsx` — shows the active restaurant name and,
  when a vendor operates multiple restaurants, a selector to switch outlets.

## API / WebSocket origin resolution

`NEXT_PUBLIC_API_BASE` and `NEXT_PUBLIC_WS_URL` control how the browser reaches
the API over HTTP and WebSocket respectively.

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_BASE` | Origin used to derive the WebSocket URL (`ws/wss`). Leave empty in preview/dev so the browser connects to the same-origin host through the Next.js proxy. |
| `NEXT_PUBLIC_WS_URL` | Explicit full WebSocket URL. Overrides `NEXT_PUBLIC_API_BASE` when set. |

Resolution order in `packages/config/ws.ts` (`getWsUrl`):

1. `NEXT_PUBLIC_WS_URL` (if set)
2. `NEXT_PUBLIC_API_BASE` (converted to `ws://` / `wss://`)
3. Same-origin browser host (preview / dev with the Next.js reverse proxy)
4. `ws://127.0.0.1:3001` fallback for SSR

In the online preview only one port is exposed, so the Next.js dev server
proxies both `/api` HTTP requests and the `/api/v1/ws` WebSocket upgrade to the
API server. See `.env.example` for the canonical variable list.
