# Phase 3 Initiation: AI Personalization & Group Orders

- Features: D07 Personalized Homepage, D17 Trending Now, O02 Group Order
- Phase: Phase 3 (User Growth)
- Role: Backend (Discovery & Ordering contexts) + UI/UX Agent
- Status: COMPLETE

## 1. Scope

SnakZap enters Phase 3 (User Growth). This phase ships three PRD features
across the Discovery (D07, D17) and Ordering (O02) bounded contexts, plus the
consumer UI. EOS Layer 1 (DDD bounded contexts, Event Catalog) applies.

## 2. D07 Personalized Homepage - Rule-based vs ML Strategy

### Strategy: Rule-based V1 with a cold-start-aware "ML-simulated" tier

The PRD asks for a personalized homepage but there is no training pipeline in
this milestone, so we ship a deterministic **Rule-based V1** that simulates the
ML ranking we will swap in later (feature store + LightGBM reranker). The model
selection is driven by a single signal: the user's past-order count.

| User state | Past orders | Strategy | Ranking signal |
|---|---|---|---|
| Cold start (anonymous / new) | 0 | Strict rule-based | Time of day + inferred location proximity |
| Early | 1-2 | Strict rule-based | Time of day + dietary tags + location |
| Warm (ML-simulated) | >= 3 | Simulated ML | Past-restaurant frequency & recency weighted above rules |

**Rule-based signal (always active):**
1. **Time of day** buckets: breakfast (05-11), lunch (11-16), evening (16-21),
   late-night (21-05). Restaurants get a small time-of-day affinity score.
2. **Dietary tags**: inferred from the user's ordered items (aggregated
   `dietary_tags`, e.g. `NON_VEG` from past chicken biryani orders). A
   restaurant whose menu overlaps the inferred tags scores higher.
3. **Location**: haversine distance from the consumer's mock location (Colaba
   18.9218, 72.8308) to each restaurant's lat/lng - closer = higher score.

**ML-simulated signal (only when `past_order_count >= 3`):**
- Every past order contributes `frequency` (how often the user ordered at that
  restaurant) and `recency` (most recent order wins). Past-restaurant affinity
  is multiplied into the base rule score so a user's habitual restaurants float
  to the top, emulating a trained model's latent preference vector.

**Anti-Filter-Bubble (non-negotiable):**
- Every response MUST include exactly one `surprise_restaurant` selected from
  restaurants that do NOT match the user's inferred dietary/location affinity
  (lowest-affinity eligible candidate), so the feed can never collapse into a
  single-preference bubble. The surprise is excluded from the ranked list and
  surfaced as its own card.

Response shape:
```jsonc
{
  "user_profile": { "is_cold_start": true, "past_order_count": 0, "inferred_dietary_tags": [], "strategy": "rule_based" },
  "personalized_restaurants": [ { "restaurant": {...}, "reason": "Near you", "score": 0.92 } ],
  "surprise_restaurant": { "restaurant": {...}, "reason": "Something new for you" }
}
```

## 3. D17 Trending Now - Algorithm

`GET /api/v1/discovery/trending` returns the top 5 dishes ordered within a
configurable radius (default 5 km) of the consumer location in the last
configurable window (default 60 minutes).

Algorithm (single pass, time-bounded):
1. **Time bound**: filter orders by `created_at >= now - minutes` - the query is
   bounded by a fixed window; anything older is invisible to Trending. Tests
   backdate orders outside the window and assert they never appear.
2. **Radius bound**: haversine distance between the consumer location (mock
   Colaba origin when no lat/lng is supplied) and each restaurant's lat/lng.
   Restaurants beyond `radius_km` are excluded.
3. **Aggregation**: per menu item, sum `quantity` and count distinct orders
   containing it.
4. **Ranking**: sort by `quantity_sold` desc, then `orders_count` desc; take the
   top 5.
5. Each trending dish carries `{ menu_item_id, name, price, restaurant_id,
   restaurant_name, orders_count, quantity_sold }` so the UI can render the
   carousel card and deep-link to the restaurant menu.

Geo-location is mocked (deterministic Colaba origin) exactly like the P04 ETA
mock, so the demo is fully offline; the service accepts optional
`lat`/`lng`/`radius_km`/`minutes` query params to override.

## 4. O02 Group Order - Concurrency Logic

### Shareable cart model

- `POST /api/v1/orders/group/create` (auth): creates a real **DRAFT** order in
  the ordering context (empty, `total_amount: 0`) owned by the creator, mints a
  URL-safe `group_cart_token`, and persists the cart in the group-cart
  repository. Returns the token + `share_link`.
- `POST /api/v1/orders/group/add` (auth): ANY authenticated user holding the
  token appends items to the same DRAFT order. The order's `items` and
  `total_amount` grow; the contributor (user, masked display name, avatar
  seed, added items) is recorded so the live cart can render avatars.
- `GET /api/v1/orders/group/cart?token=...` (public, share-key auth): the live
  group cart snapshot (order lines + contributors) for the real-time view.

### Race-condition prevention: per-token async mutex queue

Two users adding at the exact same millisecond must both persist. A plain
read-modify-write (`getById` await -> push -> save await) can interleave on the
event loop and silently drop one write. The group-cart service therefore holds a
**per-token async mutex** (`Map<token, Promise>`): every `add` chains onto the
previous operation for that token, serializing the critical section:

```ts
private readonly locks = new Map<string, Promise<unknown>>();

private async withLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.locks.get(token) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());  // run after the previous add
  this.locks.set(token, next.catch(() => {}));     // keep the chain healthy
  return next;
}
```

Inside the lock the add validates (cart exists, order still DRAFT, items belong
to the restaurant and are available), recomputes the full price breakdown from
the merged line items, persists via `orderRepo.setItems(...)` (atomic swap of
items + total), records the contributor, and emits `GroupOrderItemAdded`. A
second add that arrives mid-flight simply queues and applies after the first -
no lost updates, no data races. Because the repo is in-memory today, the mutex
is the correctness seam; with Postgres this becomes `SELECT ... FOR UPDATE` on
the cart row.

Guard: adding to an order that has left DRAFT (paid/confirmed) is rejected
`409 GROUP_ORDER_LOCKED`.

## 5. Event Catalog additions (EOS Layer 1)

| Event | Payload |
|---|---|
| `PersonalizedHomepageViewed` | `{ user_id?, strategy, is_cold_start, result_count }` |
| `TrendingQueried` | `{ radius_km, minutes, result_count }` |
| `GroupOrderCreated` | `{ order_id, group_cart_token, created_by }` |
| `GroupOrderItemAdded` | `{ order_id, group_cart_token, added_by, menu_item_id, quantity }` |

## 6. UI/UX (Teal palette, skeleton loaders)

- Homepage gains a **"Personalized For You"** tile row (reason chips) and a
  **"Trending Now"** horizontal carousel with teal badges
  (`bg-primary-500/15 text-primary-700 ring-primary-600/20`) and a flame glyph.
  Loading states use the shared `animate-skeleton-teal` shimmer.
- The cart drawer gains a **"Start Group Order"** action that creates the
  group cart and reveals a copyable share link.
- New **`/group-cart`** page renders the live group cart: contributor avatars
  (teal initial circles), masked names, per-person items, and the running
  total, polled every 2s.

## 7. Verification plan

- Vitest `discovery.test.ts`: cold-start new vs returning user differences,
  ML tier kicks in at >= 3 orders, anti-filter-bubble surprise present,
  Trending time-bounded (backdated orders excluded) + radius filter + top-5.
- Vitest `groupOrders.test.ts`: auth guards, create/add happy paths, two-user
  contribution, **concurrent-race test** (`Promise.all` of 10 simultaneous adds
  asserting every item/quantity is present), DRAFT-only guard.
- Live API verification on :3001 and consumer preview :3000.
- Evidence manifest: `work-logs/phase-3/verification.json`.

## 8. Completion summary (2026-08-06)

Shipped and verified:

- **Backend** - `services/discovery.ts` (D07 rule-based/ML-weighted ranking +
  anti-filter-bubble surprise slot; D17 time+radius-bounded trending),
  `routes/discovery.ts` (optional-auth homepage, validated trending query),
  `services/groupOrder.ts` (per-token async mutex; masked contributor
  identity via `maskPhone`/`avatarSeedOf`), `routes/groupOrders.ts`
  (create/add/cart), `repositories/groupCartRepository.ts`,
  `orderRepository.setItems`, app.ts mounts (groupOrders before ordersRouter).
- **Events** - Event catalog 13 -> 17 (`packages/types/src/events.ts`).
- **Tests** - 20 new (8 discovery + 12 group orders): cold-start new vs
  returning tiers, surprise-never-top, trending time-bound + radius + top-5,
  auth guards, two-user contribution, masked identity, 404/409 guards, and
  the `Promise.all` race tests (10 same-item adds -> quantity 10; distinct
  items -> no lost updates). Full suite 223/223, turbo typecheck 5/5.
- **Consumer UI** - `PersonalizedFeed` tiles + `TrendingCarousel` (teal
  badges, skeleton shimmer) on the homepage; `CartDrawer` "Start Group
  Order"; `/group-cart` live view (`GroupCartView`, 2s polling, avatar
  circles, masked names, copy invite link, add-my-cart seam).
- **Live** - API :3001 discovery + group order flows exercised end-to-end
  (create by user 1, add by user 2 -> `••••8888` masked contributor); consumer
  :3000 homepage + group-cart render 200.

Evidence manifest: `work-logs/phase-3/verification.json` (verdict GO).
