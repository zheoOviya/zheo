# Security Hardening Implementation Plan (12 findings from source review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 12 verified security/infra findings on `fix/security-hardening` (based on `origin/main` `90884d0`), in the priority order recommended by the reviewer.

**Architecture:** pnpm monorepo; Express API (`apps/api`) with repository abstraction (Memory repos in tests / Drizzle+Postgres in prod), a Redis singleton facade (`apps/api/src/lib/redis.ts`), a Redis Pub/Sub event bus, JWT auth (access httpOnly cookie + Bearer + refresh rotation), Razorpay payments, and a Next.js consumer app. Tests run via Vitest with `NODE_ENV=test` forcing in-memory stores.

**Tech Stack:** TypeScript, Express, Drizzle ORM + Postgres, ioredis, Zod, JWT (jose), ws, Vitest, Playwright, GitHub Actions.

## Global Constraints

- Worktree: `/tmp/opencode/security-hardening`, branch `fix/security-hardening`. Commits land here, one per task.
- Existing tests must stay green: `pnpm exec vitest run apps/api/src/services/otp.test.ts`, the API unit suite, `pnpm typecheck`, `pnpm lint`.
- Follow existing code conventions (envelope `ok()`/`AppError`, repository interfaces, `createEventEnvelope`, logger).
- No delete operations. Do not modify `origin/main`; only the feature branch.
- Every money-path change keeps the current API response shape for the frontends unless the task explicitly says otherwise.
- TDD: write failing test first, run it (confirm fail), implement, re-run (confirm pass), then commit.
- Commit messages follow repo style: `fix(scope): summary` / `chore(scope): summary` / `test(scope): summary` / `feat(scope): summary`.

---

### Task 1: Redis EventBus — dedicated subscriber connection + self-origin de-duplication

**Files:**
- Modify: `apps/api/src/lib/eventBus.ts`
- Modify: `apps/api/src/lib/redis.ts` (extend `MemoryRedis.duplicate()` to return a fresh instance sharing the same store, so tests can exercise two "connections")
- Test: `apps/api/src/lib/eventBus.test.ts` (create if absent)

**Interfaces:**
- Consumes: `getRedis(): RedisLike`, `RedisLike.on(event, listener)`, `RedisLike.duplicate()`, `RedisLike.subscribe(channel, onMessage?)`, `RedisLike.publish(channel, message)`.
- Produces: `initEventSubscriber(): Promise<void>` that subscribes on a **duplicate** connection via `on("message", cb)` (ioredis pattern) and skips self-published events; `emit()` unchanged signature.

**Problem:** `initEventSubscriber()` uses the singleton `getRedis()` connection. ioredis switches a connection to subscriber mode after `SUBSCRIBE`, so the shared connection can no longer run normal commands (rate-limit ZSETs, JWT blacklist GET/SET, OTP keys). The custom `subscribe(channel, onMessage)` signature also never delivers on real ioredis.

- [ ] **Step 1: Write failing tests** in `eventBus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventEnvelope, emit, initEventSubscriber, onEvent } from "./eventBus";
import { MemoryRedis, getRedis, resetRedisForTests, setRedisForTests } from "./redis";

class FakePubSub extends MemoryRedis {
  subscribed = false;
  messageHandlers: Array<(channel: string, message: string) => void> = [];
  override async subscribe(channel: string): Promise<void> {
    this.subscribed = true;
    return Promise.resolve();
  }
  override on(event: string, listener: (...args: unknown[]) => void) {
    if (event === "message") {
      this.messageHandlers.push(listener as (c: string, m: string) => void);
    }
    return this;
  }
  duplicate(): FakePubSub {
    return this;
  }
  simulateInbound(channel: string, message: string): void {
    for (const h of this.messageHandlers) h(channel, message);
  }
}

describe("eventBus", () => {
  beforeEach(() => {
    setRedisForTests(new FakePubSub());
    vi.resetModules();
  });
  afterEach(() => resetRedisForTests());

  it("subscribes on a duplicated connection and registers an on('message') handler (not the shared client)", async () => {
    const { initEventSubscriber } = await import("./eventBus");
    const client = getRedis();
    const dupSpy = vi.spyOn(client, "duplicate");
    await initEventSubscriber();
    expect(dupSpy).toHaveBeenCalled();
    const sub = client.duplicate() as unknown as FakePubSub;
    expect(sub.subscribed).toBe(true);
    expect(sub.messageHandlers.length).toBeGreaterThan(0);
  });

  it("does not re-dispatch an event this instance already emitted (self-origin filter)", async () => {
    const { initEventSubscriber, onEvent, emit } = await import("./eventBus");
    const handler = vi.fn();
    onEvent("OrderPlaced", handler);
    await initEventSubscriber();
    const client = getRedis();
    const sub = client.duplicate() as unknown as FakePubSub;
    const envelope = createEventEnvelope("OrderPlaced", "order-1", {});
    await emit(envelope);
    // Simulate the same instance receiving its own broadcast back.
    sub.simulateInbound("snakzap:events", JSON.stringify(envelope));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still dispatches locally on emit (in-process dispatch is unchanged)", async () => {
    const { onEvent, emit } = await import("./eventBus");
    const handler = vi.fn();
    onEvent("OrderPlaced", handler);
    await emit(createEventEnvelope("OrderPlaced", "order-1", {}));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd /tmp/opencode/security-hardening && pnpm exec vitest run apps/api/src/lib/eventBus.test.ts`
Expected: FAIL (subscribe on duplicate not used; self-event double-dispatch).

- [ ] **Step 3: Implement**

In `apps/api/src/lib/eventBus.ts`:
- Add a module-scoped `const recentlyEmitted = new Set<string>();` and a prune counter.
- In `emit()`: after `dispatchToHandlers`, add `event.event_id` to `recentlyEmitted` (prune when size > 10_000 by clearing oldest — simplest: `if (recentlyEmitted.size > 10_000) recentlyEmitted.clear();`).
- Rewrite `initEventSubscriber()`:

```ts
export async function initEventSubscriber(): Promise<void> {
  if (subscriberInitialized) return;
  subscriberInitialized = true;

  try {
    const redis = getRedis();
    const sub = redis.duplicate();
    sub.on("message", (channel: string, message: string) => {
      if (channel !== EVENT_CHANNEL) return;
      try {
        const event = JSON.parse(message) as TypedEventEnvelope<EventName>;
        if (recentlyEmitted.has(event.event_id)) return;
        void dispatchToHandlers(event);
      } catch (err) {
        logger.error({
          message: "event_subscriber_dispatch_error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await sub.subscribe(EVENT_CHANNEL);
    logger.info({ message: "event_subscriber_initialized", channel: EVENT_CHANNEL });
  } catch (err) {
    logger.warn({
      message: "event_subscriber_init_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

In `apps/api/src/lib/redis.ts`: make `MemoryRedis.duplicate()` return a fresh `MemoryRedis` that shares the same `store`/`zsets`:

```ts
duplicate(): RedisLike {
  const copy = new MemoryRedis();
  copy.store = this.store;
  copy.zsets = this.zsets;
  return copy;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd /tmp/opencode/security-hardening && pnpm exec vitest run apps/api/src/lib/eventBus.test.ts`
Expected: PASS (all 3 tests). Then run full API unit suite to check no regressions: `pnpm exec vitest run apps/api` (must stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/eventBus.ts apps/api/src/lib/redis.ts apps/api/src/lib/eventBus.test.ts
git commit -m "fix(events): subscribe on a duplicate Redis connection and filter self-origin broadcasts"
```

---

### Task 2: Server-authoritative pricing (client cannot set/negate prices)

**Files:**
- Modify: `apps/api/src/services/ordering.ts`
- Modify: `apps/api/src/services/pricing.ts` (add positive-total guard helper if clean to do there)
- Test: `apps/api/src/services/ordering.test.ts` (or pricing.test.ts) — add regression tests

**Interfaces:**
- Consumes: `CatalogRepository.getMenuItemById(id): Promise<MenuItemDTO | null>` where `MenuItemDTO.customizations: unknown[]` (shape `{ name: string; price_delta: number }[]`).
- Produces: `PlaceOrderRequest.items[].customizations` still typed as `CustomizationDelta[]` but `price_delta` from the client is **ignored**; the server resolves price from the catalog item's own `customizations` by `name`. Unknown customization names → `AppError("INVALID_CUSTOMIZATION", ..., 400)`. Total `<= 0` → `AppError("INVALID_ORDER_AMOUNT", ..., 400)`.

**Problem:** Client sends `{name, price_delta}` with unbounded negative deltas; `ordering.ts:100-101` trusts them and `pricing.ts:58-63,86` sums them into the total.

- [ ] **Step 1: Write failing tests** (append to `ordering.test.ts`):

```ts
it("rejects client-supplied customization prices and uses the catalog's own price", async () => { /* arrange: menu item with customizations [{name:"Extra",price_delta:30}]; submit order with customizations [{name:"Extra",price_delta:-499}] -> item.customization_total === 30, total reflects 30, not -499 */ });

it("rejects a customization name that does not exist in the catalog item", async () => { /* expect AppError INVALID_CUSTOMIZATION */ });

it("rejects an order whose server-computed total is not positive", async () => { /* menu item price 10 with customization -10 -> total <= 0 -> AppError INVALID_ORDER_AMOUNT */ });
```

Check the existing test helpers in `ordering.test.ts` for how a menu item is seeded (the Memory catalog repo) before writing — mirror them.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/services/ordering.test.ts`
Expected: FAIL (client delta still trusted).

- [ ] **Step 3: Implement**

In `apps/api/src/services/ordering.ts`:
- Add a resolver used per non-gift item:

```ts
interface CatalogCustomization { name: string; price_delta: number; }

function resolveCustomizations(
  menuCustomizations: unknown[],
  requested: CustomizationDelta[],
): CustomizationDelta[] {
  const catalogMap = new Map<string, number>();
  for (const raw of menuCustomizations) {
    const c = raw as CatalogCustomization;
    if (c && typeof c.name === "string" && typeof c.price_delta === "number") {
      catalogMap.set(c.name, c.price_delta);
    }
  }
  return requested.map((req) => {
    const price = catalogMap.get(req.name);
    if (price === undefined) {
      throw new AppError(
        "INVALID_CUSTOMIZATION",
        `Customization "${req.name}" is not offered for this item`,
        400,
      );
    }
    return { name: req.name, price_delta: price };
  });
}
```

- Replace `let customizations = item.customizations;` (line ~101) with `const customizations = resolveCustomizations(menuItem.customizations ?? [], item.customizations);`.
- The gift branch stays (already zeroes deltas from the server snapshot).
- After `const breakdown = calculatePriceBreakdown(orderItems);` add:

```ts
if (breakdown.total_amount <= 0) {
  throw new AppError("INVALID_ORDER_AMOUNT", "Order total must be positive", 400);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm exec vitest run apps/api/src/services/ordering.test.ts apps/api/src/services/pricing.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ordering.ts apps/api/src/services/ordering.test.ts
git commit -m "fix(ordering): resolve customization prices server-side from the catalog and reject non-positive totals"
```

---

### Task 3: Payment ownership (BOLA/IDOR on POST /payments/create-order)

**Files:**
- Modify: `apps/api/src/services/payments.ts`
- Modify: `apps/api/src/routes/payments.ts`
- Modify: `apps/api/src/repositories/orderRepository.ts` (interface — add `userId` to `OrderDTO` if not already there; verify first)
- Test: `apps/api/src/services/payments.test.ts`

**Interfaces:**
- Consumes: `OrderDTO` (must include `user_id`), `res.locals.userId`.
- Produces: `PaymentService.createPaymentOrder(orderId: string, userId: string, method: PaymentMethod)`. Throws `AppError("FORBIDDEN", "Not your order", 403)` when `order.user_id !== userId`.

- [ ] **Step 1: Write failing test** in `payments.test.ts`:

```ts
it("rejects creating a payment for another user's DRAFT order", async () => {
  // seed an order owned by user-A; call createPaymentOrder(orderId, userB, "cod")
  // expect AppError FORBIDDEN
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm exec vitest run apps/api/src/services/payments.test.ts`
Expected: FAIL (no ownership check exists).

- [ ] **Step 3: Implement**

In `services/payments.ts`:
- Change signature to `async createPaymentOrder(orderId: string, userId: string, method: PaymentMethod = "upi")`.
- After the `if (!order)` check, add:

```ts
if (order.user_id !== userId) {
  throw new AppError("FORBIDDEN", "Not your order", 403);
}
```

In `routes/payments.ts`: pass `res.locals.userId as string` as the second argument to `createPaymentOrder`.
Update all other callers/tests of `createPaymentOrder` (grep `createPaymentOrder(`).

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm exec vitest run apps/api/src/services/payments.test.ts` then the full `apps/api` suite; `pnpm typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/payments.ts apps/api/src/routes/payments.ts apps/api/src/services/payments.test.ts
git commit -m "fix(payments): enforce order ownership when creating a payment"
```

---

### Task 4: Payment idempotency + DB uniqueness for payment creation

**Files:**
- Modify: `packages/db/src/schema/payments.ts` (add partial unique indexes)
- Modify: `packages/db/drizzle/*` (generate migration via `pnpm --filter @snakzap/db db:generate`)
- Modify: `apps/api/src/repositories/orderRepository.ts` + `apps/api/src/repositories/drizzle/drizzleOrderRepository.ts` + memory order repo: add `updateStatusIf(orderId, fromStatus, toStatus)` (CAS)
- Modify: `apps/api/src/services/payments.ts` (idempotent payment creation; CAS status transitions)
- Modify: `apps/api/src/repositories/paymentRepository.ts` (+ drizzle impl): `create` becomes resilient to unique violations → return existing
- Test: `apps/api/src/services/payments.test.ts`

**Interfaces:**
- Produces: `OrderRepository.updateStatusIf(orderId: string, from: OrderStatus, to: OrderStatus): Promise<OrderDTO | null>` (null when the current status is not `from`).
- Produces: `PaymentRepository.getByOrderId(orderId): Promise<PaymentDTO | null>` (exists already).
- `payments.order_id` and `payments.gift_id` each get a **partial unique index** (`WHERE order_id IS NOT NULL` / `WHERE gift_id IS NOT NULL`).

**Problem:** two parallel `createPaymentOrder` calls both pass the `DRAFT` check and mint two Razorpay orders + two payment rows; gift mutex is single-process only.

- [ ] **Step 1: Write failing tests** (in `payments.test.ts`):

```ts
it("returns the existing Razorpay order for a DRAFT->pending order instead of minting a second one", async () => {
  // createPaymentOrder(orderId, userId, "upi") twice sequentially
  // expect razorpay_order_id identical and paymentRepo count for orderId === 1
});

it("does not re-confirm a COD order that already left DRAFT", async () => {
  // create COD payment once (order -> CONFIRMED), then attempt again
  // expect AppError ORDER_NOT_DRAFT (status no longer DRAFT) AND order status still CONFIRMED
});
```

Note: for the DB-level unique constraint, the strongest verification happens in the Task 6 integration suite against real Postgres. Unit tests cover the service-level idempotency and CAS logic with Memory repos.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/services/payments.test.ts`
Expected: FAIL (duplicate Razorpay order minted; no CAS).

- [ ] **Step 3: Implement**

Schema (`packages/db/src/schema/payments.ts`): inside the table extra config add:

```ts
uniqueOrder: uniqueIndex("payments_order_unique_idx").on(table.order_id).where(sql`${table.order_id} IS NOT NULL`),
uniqueGift: uniqueIndex("payments_gift_unique_idx").on(table.gift_id).where(sql`${table.gift_id} IS NOT NULL`),
```

(add `uniqueIndex` to the drizzle imports.) Generate the migration: `pnpm --filter @snakzap/db db:generate`.

Repository CAS: add `updateStatusIf` to the `OrderRepository` interface; implement in `DrizzleOrderRepository` as:

```ts
async updateStatusIf(orderId: string, from: OrderStatus, to: OrderStatus): Promise<OrderDTO | null> {
  const result = await this.db
    .update(orders)
    .set({ status: to, updated_at: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, from)))
    .returning();
  if (result.length === 0) return null;
  return this.mapOrder(result[0]);
}
```

and in `MemoryOrderRepository` with an in-array status compare. Wire the shared repo type.

Service (`services/payments.ts`):
- Online path: before minting a Razorpay order, `const existing = await this.paymentRepo.getByOrderId(order.id);` — if `existing` and status in (`CREATED`, `AUTHORIZED`) return the existing Razorpay order; if `CAPTURED`/`REFUNDED` throw `ORDER_ALREADY_PAID`; if `FAILED` allow retry (create new).
- Use CAS for the DRAFT→ status transitions: after creating the payment row, `await this.orderRepo.updateStatusIf(order.id, "DRAFT", "PAYMENT_PENDING")` and for COD `updateStatusIf(order.id, "DRAFT", "CONFIRMED")`. If it returns null, another request already transitioned the order → throw `ORDER_NOT_DRAFT`.
- Wrap `paymentRepo.create` (online + gift) in a try/catch that, on a unique-violation error, re-fetches by order/gift id and returns the existing row (treat as idempotent) rather than failing.
- Keep the gift mutex; the DB unique index is the cross-instance backstop.

- [ ] **Step 4: Run tests to confirm they pass + full suite + typecheck**

Run: `pnpm exec vitest run apps/api/src/services/payments.test.ts && pnpm exec vitest run apps/api && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/payments.ts packages/db/drizzle apps/api/src/repositories apps/api/src/services/payments.ts apps/api/src/services/payments.test.ts
git commit -m "fix(payments): idempotent payment creation with partial-unique constraints and CAS status transitions"
```

---

### Task 5: Refresh rotation re-reads current user role/suspension

**Files:**
- Modify: `apps/api/src/services/jwt.ts`
- Modify: `apps/api/src/services/jwt.test.ts`
- Possibly modify: `apps/api/src/repositories/shared.ts` (expose `sharedIdentityRepo` without circular import risk)

**Interfaces:**
- Produces: `JwtService.rotateRefreshToken(oldToken, device_fingerprint)` now takes an optional user-context resolver: `rotateRefreshToken(oldToken, device_fingerprint, loadUser?: (sub: string) => Promise<{ role: string; isSuspended: boolean } | null>)`. When `loadUser` is provided and returns null → 401 `ACCOUNT_NOT_FOUND`; returns `isSuspended: true` → 403 `ACCOUNT_SUSPENDED`; otherwise the new pair is issued with the **resolved** role (not `claims.role`).
- The `/refresh` route passes a resolver backed by `sharedIdentityRepo` reading the current user row.

**Problem:** `rotateRefreshToken` re-issues using `claims.role` from the stale token; a demoted/suspended user keeps old privileges.

- [ ] **Step 1: Write failing tests** in `jwt.test.ts`:

```ts
it("issues the new pair with the DB role, not the stale JWT role", async () => {
  const pair = jwtService.issuePair({ sub: "u1", phone: "+91", role: "admin", device_fingerprint: "fp" });
  const rotated = await jwtService.rotateRefreshToken(pair.refreshToken, "fp", async () => ({ role: "customer", isSuspended: false }));
  expect(rotated.accessToken).not.toBe(pair.accessToken);
  // decode access token -> role === "customer"
});

it("rejects refresh for a suspended account", async () => {
  // expect AppError ACCOUNT_SUSPENDED (403)
});

it("rejects refresh when the user no longer exists", async () => {
  // expect AppError ACCOUNT_NOT_FOUND (401)
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/services/jwt.test.ts`
Expected: FAIL (no role re-read).

- [ ] **Step 3: Implement**

In `services/jwt.ts`:
- Extend `rotateRefreshToken` with the optional `loadUser` resolver as described. Keep backward compatibility (when `loadUser` undefined, behave as today — used by callers that have no identity repo).
- Read the IdentityRepository DTO shape first (fields `role`, `is_suspended`/`suspended`) to map correctly; adapt `loadUser` to return normalized `{ role, isSuspended }`.

In `routes/auth.ts` `/refresh` handler: pass a resolver:

```ts
await jwtService.rotateRefreshToken(oldRefresh, body.data.device_fingerprint, async (sub) => {
  const user = await sharedIdentityRepo.getById(sub);
  if (!user) return null;
  return { role: user.role, isSuspended: Boolean(user.is_suspended) };
});
```

(check the actual field name on the Identity DTO and use it).

- [ ] **Step 4: Run tests to confirm they pass + full suite + typecheck**

Run: `pnpm exec vitest run apps/api/src/services/jwt.test.ts && pnpm exec vitest run apps/api && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/src/services/jwt.test.ts apps/api/src/routes/auth.ts
git commit -m "fix(auth): re-read user role and suspension state on refresh rotation"
```

---

### Task 6: Real Redis/Postgres integration tests in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (add `services:` for postgres + redis; add integration test step)
- Modify: `apps/api/src/lib/redis.ts` (`getRedis()` honors an explicit real-infra opt-in in test env)
- Modify: `apps/api/src/lib/db.ts` (`createDb()` allows test-mode when real-infra opted in)
- Modify: `apps/api/src/repositories/shared.ts` (`isMemoryMode()` honors the opt-in)
- Modify: `apps/api/vitest.config.ts` or add `apps/api/vitest.integration.config.ts` + `apps/api/test/integration/*.test.ts`
- Modify: `package.json`/`apps/api/package.json` scripts (`test:integration`)

**Interfaces:**
- Produces env contract: `TEST_REAL_INFRA=true` + `DATABASE_URL` + `REDIS_URL` forces real Postgres + real Redis even when `NODE_ENV=test`.
- Produces integration tests: `eventBus.integration.test.ts` (publish on one connection → subscriber on a duplicate receives it, and self-origin events are not re-dispatched), `payments.integration.test.ts` (two parallel `createPaymentOrder` calls → exactly one payment row thanks to the unique index; COD CAS only confirms once).

**Problem:** `NODE_ENV=test` forces MemoryRedis/memory repos everywhere, so the EventBus wiring and DB races never hit real infra in CI; `ci.yml` has no service containers.

- [ ] **Step 1: Add infra opt-in**

`apps/api/src/lib/redis.ts`:

```ts
const useRealRedis =
  process.env.TEST_REAL_INFRA === "true" && Boolean(config.redis.url);
if (!useRealRedis && (process.env.NODE_ENV === "test" || !config.redis.url)) {
  client = new MemoryRedis();
  return client;
}
```

`apps/api/src/lib/db.ts` `createDb()`: replace the hard throw with a conditional:

```ts
if (process.env.NODE_ENV === "test" && process.env.TEST_REAL_INFRA !== "true") {
  throw new Error("DB not available in test mode - use Memory repositories");
}
```

`apps/api/src/repositories/shared.ts` `isMemoryMode()`:

```ts
const realInfra = process.env.TEST_REAL_INFRA === "true";
return (!realInfra && process.env.NODE_ENV === "test") || process.env.USE_MEMORY_REPOS === "true" || !isDbAvailable();
```

- [ ] **Step 2: Add integration test runner**

Add `apps/api/vitest.integration.config.ts` extending the base config with `setupFiles: ["./test/integration/setup.ts"]`, `env` including `TEST_REAL_INFRA: "true"`. `test/integration/setup.ts` runs `migrate` (import the drizzle migrate script programmatically or exec `pnpm --filter @snakzap/db db:migrate`) against `DATABASE_URL` before tests. Verify how migrations are normally applied (check `packages/db/drizzle.config.ts` / existing migrate usage) and reuse it.

Add script in `apps/api/package.json`: `"test:integration": "vitest run --config vitest.integration.config.ts"`.

Write `apps/api/test/integration/eventBus.integration.test.ts` and `apps/api/test/integration/payments.integration.test.ts` per the Interfaces description (real Redis Pub/Sub delivery; real unique-index race).

- [ ] **Step 3: Run locally against local Postgres/Redis if available (or document skip)**

Run: `TEST_REAL_INFRA=true DATABASE_URL=postgres://postgres:postgres@localhost:5432/snakzap REDIS_URL=redis://localhost:6379 pnpm --filter @snakzap/api test:integration`
If no local Postgres/Redis exists, this step may be skipped locally — CI is the gate.

- [ ] **Step 4: Wire CI**

`.github/workflows/ci.yml`: add a `services:` block on the `ci` job:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: snakzap
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 10s --health-timeout 5s --health-retries 5
  redis:
    image: redis:7-alpine
    ports:
      - 6379:6379
    options: >-
      --health-cmd "redis-cli ping"
      --health-interval 10s --health-timeout 5s --health-retries 5
```

Add a step after the unit-test step:

```yaml
- name: Integration tests (real Redis + Postgres)
  run: pnpm --filter @snakzap/api test:integration
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/snakzap
    REDIS_URL: redis://localhost:6379
    TEST_REAL_INFRA: "true"
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/redis.ts apps/api/src/lib/db.ts apps/api/src/repositories/shared.ts apps/api/vitest.integration.config.ts apps/api/test/integration apps/api/package.json .github/workflows/ci.yml
git commit -m "ci: run integration tests against real Redis and Postgres service containers"
```

---

### Task 7: Fatal process errors shut the API down cleanly

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts` (create if absent; otherwise add a unit test for an extracted `installFatalHandlers` helper)

**Interfaces:**
- Produces: `installFatalHandlers({ onFatal }): void` (extracted helper) that on `uncaughtException`/`unhandledRejection` logs, calls `onFatal()` (graceful shutdown) and exits 1 after a short timeout.

**Problem:** `index.ts:11-19` log-only handlers keep a possibly-corrupt process serving traffic.

- [ ] **Step 1: Write failing test** for the extracted helper (in a new `apps/api/src/lib/fatalHandlers.ts` + `fatalHandlers.test.ts`):

```ts
it("calls onFatal and exits 1 on uncaughtException", async () => {
  const onFatal = vi.fn();
  const exit = vi.fn();
  installFatalHandlers({ onFatal, processExit: exit as unknown as (c: number) => never });
  process.emit("uncaughtException", new Error("boom"));
  await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
  expect(exit).toHaveBeenCalledWith(1);
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm exec vitest run apps/api/src/lib/fatalHandlers.test.ts`
Expected: FAIL (handlers don't exist yet / log-only).

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/fatalHandlers.ts`:

```ts
import { logger } from "./logger";

export interface FatalHandlersOptions {
  onFatal: () => void;
  processExit?: (code: number) => never;
  exitTimeoutMs?: number;
}

export function installFatalHandlers({
  onFatal,
  processExit = (code) => process.exit(code),
  exitTimeoutMs = 10_000,
}: FatalHandlersOptions): void {
  const fatal = (kind: string, err: unknown): void => {
    logger.error({
      message: `${kind}: fatal error, shutting down`,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    onFatal();
    setTimeout(() => processExit(1), exitTimeoutMs).unref();
  };
  process.on("unhandledRejection", (reason) => fatal("unhandled_rejection", reason));
  process.on("uncaughtException", (err) => fatal("uncaught_exception", err));
}
```

In `apps/api/src/index.ts`: replace the log-only handlers with `installFatalHandlers({ onFatal: () => shutdown("FATAL") })` — but `shutdown` is defined inside `main()`. Restructure so `shutdown` is hoisted above the call, or move the install inside `main()` after `shutdown` is defined (still registered on the process, so it works). Simplest: move the two `process.on` registrations to after `shutdown` is defined inside `main()`, delegating to `shutdown("fatal")`, and keep `process.exit(0)` in shutdown for signal handlers but force exit 1 on fatal by passing a flag. Implementation detail: give `shutdown` an optional `exitCode = 0` param.

- [ ] **Step 4: Run tests to confirm they pass + typecheck + lint**

Run: `pnpm exec vitest run apps/api/src/lib/fatalHandlers.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/fatalHandlers.ts apps/api/src/lib/fatalHandlers.test.ts apps/api/src/index.ts
git commit -m "fix(api): shut down with a non-zero exit on uncaughtException and unhandledRejection"
```

---

### Task 8: TOTP rate-limit binds attempts to the ticket, and phone in body is validated

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Test: `apps/api/src/routes/auth.test.ts` (or `apps/api/src/middleware/rateLimiter.test.ts` if identifier extraction is factored out)

**Interfaces:**
- Produces: `totpLimiter.identifier` uses `req.body?.totp_ticket ?? req.body?.phone ?? req.ip ?? "unknown"` so rotating `phone` no longer resets the bucket.
- `/totp/verify` validates that when `phone` is present in the body it equals `user.phone` (else `AppError("PHONE_MISMATCH", ..., 400)`).

**Problem:** limiter keyed by body `phone`; the handler uses the ticket's `sub` identity and never validates phone, so a ticket holder can rotate phones to evade the 5/min cap.

- [ ] **Step 1: Write failing tests** in `auth.test.ts`:

```ts
it("binds TOTP verify rate limiting to the ticket, not the body phone", async () => {
  // build the totp limiter identifier logic test: same totp_ticket + different phones must yield the same key
});

it("rejects a TOTP verify whose body phone does not match the user", async () => {
  // create ticket for user with phone +919999999999; call /totp/verify with phone +918888888888 -> 400 PHONE_MISMATCH
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/routes/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `routes/auth.ts`:
- Change `totpLimiter.identifier` to include `req.body?.totp_ticket`.
- In `/totp/verify` handler, after resolving `user`, add:

```ts
if (body.data.phone && body.data.phone !== user.phone) {
  throw new AppError("PHONE_MISMATCH", "Phone number does not match this account", 400);
}
```

(check the exact `body.data.phone` path in the existing handler).

- [ ] **Step 4: Run tests to confirm they pass + typecheck**

Run: `pnpm exec vitest run apps/api/src/routes/auth.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "fix(auth): bind TOTP rate limiting to the ticket and validate body phone"
```

---

### Task 9: Access token no longer exposed to JS (httpOnly-only)

**Files:**
- Modify: `apps/api/src/routes/auth.ts` (stop returning `access_token` in JSON; keep httpOnly cookies + non-sensitive fields)
- Modify: `apps/consumer/lib/api.ts`, `apps/consumer/lib/store.ts` (cookie-based auth: `credentials: "include"`, drop Bearer/accessToken for API calls; keep an in-memory `isAuthenticated` flag derived from `/me`)
- Modify: `apps/vendor`, `apps/admin` similarly (grep for `access_token` / `Authorization` usage)
- Modify: auth flow tests + frontend tests

**Interfaces:**
- Produces: server auth responses no longer contain `access_token`. The httpOnly access cookie is the only credential the browser holds.
- Produces: `apps/consumer/lib/api.ts` `authedFetcher` uses `fetch(url, { credentials: "include" })` with no `Authorization` header.

**Problem:** despite httpOnly cookies, `access_token` is returned in JSON and held/sent by JS (Zustand + Bearer), so an XSS can read it.

- [ ] **Step 1: Write failing (expectation) tests**

Update `apps/api/src/routes/auth.test.ts`: assert `/consumer/verify-otp` and `/refresh` responses have **no** `access_token` field in `data`.
Update `apps/consumer/lib/store.test.ts`: assert `authedFetcher` issues requests with `credentials: "include"` and **without** an `Authorization` header.

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/routes/auth.test.ts && pnpm --filter @snakzap/consumer test`
Expected: FAIL.

- [ ] **Step 3: Implement**

Server (`routes/auth.ts`): remove `access_token` from every `ok(res, {...})` payload (verify-otp, refresh, admin/vendor/consumer/totp verify). Keep `user`, `refresh_token` only if consumed, and the httpOnly cookie set. Confirm nothing server-side depends on the response containing `access_token` (check `apps/api` for `access_token` consumers).

Consumer (`apps/consumer/lib/api.ts`): make every authed request include `credentials: "include"` and drop the `Authorization` header; `apps/consumer/lib/store.ts`: stop storing `accessToken` from responses (no longer present); derive auth state from `/me`; keep WS token retrieval from the cookie for Task 10 (transitional). Repeat for `apps/vendor` and `apps/admin` (grep `access_token`, `Bearer`, `getAuthHeaders`).

- [ ] **Step 4: Run tests to confirm they pass + full suite + typecheck + lint**

Run: `pnpm exec vitest run apps/api && pnpm --filter @snakzap/consumer test && pnpm --filter @snakzap/vendor test && pnpm --filter @snakzap/admin test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts apps/consumer apps/vendor apps/admin
git commit -m "fix(auth): keep the access JWT httpOnly-only and stop returning it to client JS"
```

---

### Task 10: WebSocket hardening (no query-token auth, origin + payload limits)

**Files:**
- Modify: `apps/api/src/lib/websocket.ts`
- Modify: `apps/consumer/hooks/useWebSocket.ts`, `apps/vendor/hooks/useOrdersWebSocket.ts` (stop appending `?token=`)
- Modify: `apps/api/src/lib/websocket.test.ts` (if present)
- Possibly modify `playwright.config.ts` / e2e helpers if they rely on query-token

**Interfaces:**
- Produces: `authenticateConnection` no longer accepts `?token=` (cookie or `Authorization` header only — header stays for non-browser clients).
- `new WebSocketServer({ server })` gets `maxPayload: 16 * 1024` and a `verifyClient` that rejects requests with an unexpected `Origin` (allow empty, localhost dev origins, and `*.monkeycode-ai.live`), returning 403 otherwise.
- Per-client message handling: reject JSON payloads larger than `maxPayload` and cap the `subscriptions` Set (e.g. 50).

**Problem:** tokens leak via query strings; WSS is bare (no origin validation, ~100 MiB default payload cap, no subscription cap).

- [ ] **Step 1: Write failing tests** in `websocket.test.ts`:

```ts
it("rejects handshakes authenticated only via ?token=", async () => { /* build a fake upgrade request with ?token=... -> 401 */ });
it("rejects handshakes from an unexpected Origin", async () => { /* Origin: https://evil.example -> 403 */ });
it("closes clients that exceed maxPayload", async () => { /* simulate a message > maxPayload -> close */ });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm exec vitest run apps/api/src/lib/websocket.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/lib/websocket.ts`:
- Remove the `url.searchParams.get("token")` branch in `authenticateConnection`.
- `new WebSocketServer({ server, maxPayload: 16 * 1024, verifyClient: originCheck })` where `originCheck` allows missing/empty origin, `localhost`, `127.0.0.1`, and `*.monkeycode-ai.live`, else 403.
- On message: if `rawMessage.length > maxPayload` close 1009; cap `client.subscriptions.size` at 50 with close/error.

Consumer/vendor hooks: remove the `?token=` logic; rely on the httpOnly access cookie (same-origin WS via the rewrite/proxy). If the WS connects cross-origin, note that the cookie path requires same-site; update `WS_URL` accordingly.

- [ ] **Step 4: Run tests to confirm they pass + typecheck + lint**

Run: `pnpm exec vitest run apps/api/src/lib/websocket.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/websocket.ts apps/api/src/lib/websocket.test.ts apps/consumer/hooks/useWebSocket.ts apps/vendor/hooks/useOrdersWebSocket.ts
git commit -m "fix(ws): drop query-token auth, validate Origin, and cap payload size"
```

---

### Task 11: Slim, non-root Docker runtime image

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Produces: runtime stage copies only `apps/api/dist`, the needed `packages/*/dist` (+ their `package.json`), `node_modules` pruned to production deps (`pnpm install --prod` or `--filter @snakzap/api --prod`), and runs as non-root `USER node`.

**Problem:** full workspace `node_modules` + `apps/api` + `packages` copied; runs as root.

- [ ] **Step 1: Verify current image behavior (baseline)**

Run: `docker build -t snakzap-api:before . && docker run --rm --entrypoint whoami snakzap-api:before` → `root`; inspect image size with `docker images snakzap-api:before`.

- [ ] **Step 2: Implement the Dockerfile changes**

- In the `deps` stage, install production-only deps into a separate dir: `pnpm install --frozen-lockfile --prod --filter @snakzap/api...` (with the workspace packages), or use `pnpm deploy --filter @snakzap/api --prod /prod/app` to produce a pruned output.
- In `runtime`: `COPY --from=deps /prod/app ./app`, `WORKDIR /app`, `USER node`, keep the healthcheck (needs `wget` present — node:22-alpine includes busybox wget; confirm), `CMD ["node", "dist/index.js"]`.
- Verify `apps/api/dist` is self-contained (config/db/types compiled as workspace deps referenced by relative path in dist? confirm how `@snakzap/*` resolve at runtime — they are compiled by tsc project references, so dist only needs node_modules runtime deps; verify with the built image).

- [ ] **Step 3: Verify the new image**

Run: `docker build -t snakzap-api:after . && docker run --rm --entrypoint whoami snakzap-api:after` → `node`; start it with `DATABASE_URL`/`REDIS_URL` unset (memory fallback) and hit `/health` → 200. Compare image sizes (before vs after).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore(docker): slim runtime image with prod-only deps and a non-root user"
```

---

### Task 12: Correct request-rate metric

**Files:**
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/app.ts` (record request timestamps / emit gauge each second, or compute rate from a sliding window)
- Test: `apps/api/src/routes/metrics.test.ts` (create if absent)

**Interfaces:**
- Produces: `metrics` keeps `requests`/`errors`/`totalDurationMs` counters plus a **sliding-window** request count: `recordRequest()` appends `Date.now()` to a bounded array (cap e.g. 5000 entries); `/metrics` computes `requests in last 60s / 60` as the real per-second rate and also exposes `snakzap_http_requests_last_60s`.

**Problem:** `requests / 60` is lifetime-total/60, not a rate.

- [ ] **Step 1: Write failing test** in `metrics.test.ts`:

```ts
it("computes rate from a 60s sliding window, not lifetime totals", async () => {
  // seed metrics.requestTimes with 30 entries 10s ago and 90 entries now
  // GET /metrics -> snakzap_http_rate_per_minute is based on the window (90/min = 1.5/s), not lifetime/60
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm exec vitest run apps/api/src/routes/metrics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `metrics.ts`:
- Add `export const requestTimes: number[] = [];` and `export function recordRequest(now = Date.now()): void { requestTimes.push(now); while (requestTimes.length > 5000) requestTimes.shift(); }`.
- In the `/` handler: `const windowStart = Date.now() - 60_000; const inWindow = metrics.requests > 0 ? requestTimes.filter((t) => t >= windowStart).length : 0; const ratePerSec = inWindow / 60;` and export `snakzap_http_requests_last_60s` + the gauge.
In `app.ts` request middleware: call `recordRequest()` where `metrics.requests += 1` currently happens.

- [ ] **Step 4: Run tests to confirm they pass + typecheck**

Run: `pnpm exec vitest run apps/api/src/routes/metrics.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/metrics.ts apps/api/src/routes/metrics.test.ts apps/api/src/app.ts
git commit -m "fix(metrics): report a true 60s sliding-window request rate"
```

---

## Execution Order & Review Gates

After each task: run that task's tests + `pnpm exec vitest run apps/api` + `pnpm typecheck` (+ `pnpm lint` where noted). Commit each task separately. After all 12 tasks: run the full API unit suite, the three frontend suites, the consumer e2e suite (with the API limiter bump from before if needed), and `pnpm build` before opening the PR.

## Self-Review Notes

- Task 4's migration must be committed (generated SQL under `packages/db/drizzle`).
- Task 6 depends on Task 1 (EventBus fix) and Task 4 (unique constraints) being merged first so the integration tests exercise the fixed behavior.
- Task 9 depends on the fact that `authenticate` already resolves the httpOnly access cookie (`middleware/auth.ts:resolveAccessToken`), so removing the Bearer path from the frontends is safe once cookies are set.
- Task 10 must coordinate with Task 9: WS auth via cookie requires the cookie to be sent on the WS upgrade (same-site); the hooks must not force `?token=`.
- Verify Identity DTO field names (`role`, `is_suspended`) before Task 5; verify `OrderDTO.user_id` before Task 3.
