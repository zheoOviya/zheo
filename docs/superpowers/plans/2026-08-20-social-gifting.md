# Social Gifting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer buy a specific menu item (sender-chosen customizations/spice) as a gift, share a link + 8-char code, let the recipient claim it into their cart at ₹0, pick it up, and credit the sender's loyalty stamp on fulfillment.

**Architecture:** First-class durable `gifts` table with a status state machine (`PENDING → ACTIVE → CLAIMED → FULFILLED`, plus `EXPIRED / REFUNDING / REFUNDED / CANCELLED`). Gift payments reuse the existing Razorpay payment infra by making the `payments` table polymorphic (`order_id` nullable + `gift_id`). Recipient orders record redeemed gifts via `order_items.gift_id` at ₹0. Expiry/refund is driven by a daily sweep + Razorpay refund webhook. Implements the repo pattern (interface + Drizzle + Memory) already used across the API.

**Tech Stack:** TypeScript, pnpm monorepo, Express 5, Drizzle ORM + Postgres, zod, Razorpay, Next.js 15 (consumer app), React 19, vitest, react-hot-toast, @heroicons/react.

## Global Constraints

- Monorepo: `apps/api` (Express), `apps/consumer` (Next.js), `packages/db` (Drizzle schema), `packages/types` (shared zod + event types).
- Tests run from the repo root for API/db/types: `pnpm exec vitest run <path-from-root>`. Consumer tests run app-scoped: `pnpm --filter @snakzap/consumer exec vitest run <path-relative-to-apps/consumer>`.
- Storage pattern: `apps/api/src/repositories/*Repository.ts` = interface + `Memory*Repository`; `apps/api/src/repositories/drizzle/*Repository.ts` = Drizzle impl; wiring in `apps/api/src/repositories/shared.ts` as a lazy proxy (`shared*Repo`).
- Auth: `authenticate` middleware puts `res.locals.userId`. Errors via `AppError(code, message, status, details?)` from `../middleware/envelope`; responses via `ok(res, data, status?)`.
- Events: add typed events to `packages/types/src/events.ts` (enum `EventNameSchema`, payload schemas, `EventPayloadMap`); emit via `createEventEnvelope(name, aggregateId, payload)` + `emit(...)` from `apps/api/src/lib/eventBus`; subscribe via `onEvent(name, handler)`.
- Razorpay is in mock mode when `NODE_ENV=test` or no key: signatures must start with `valid_sig_`, order ids `order_mock_...`, payment ids `pay_mock_...`.
- Money is decimal(10,2) stored as strings in Drizzle, numbers in DTOs; amounts to Razorpay are in paise.
- No emoji anywhere. UI copy in plain English. Comments only where the existing code style requires them (module banners).
- Commit per task with the exact message given.
- New gift events: `GiftPaid`, `GiftFulfilled`, `GiftExpired`, `GiftRefunded`.

## File Structure

**Schema / types**
- `packages/db/src/schema/gifts.ts` (new) — `gifts` table + `giftStatusEnum` + `GiftItemSnapshot` type
- `packages/db/src/schema/payments.ts` (modify) — `order_id` nullable + `gift_id` uuid + index
- `packages/db/src/schema/ordering.ts` (modify) — `order_items.gift_id` uuid
- `packages/db/src/schema/index.ts` (modify) — export gifts
- `packages/types/src/events.ts` (modify) — 4 new events
- `packages/db/src/schema.test.ts` (modify) — migration-SQL assertions

**API**
- `apps/api/src/repositories/giftRepository.ts` (new) — interface + Memory impl + `GiftDTO` + `CreateGiftInput`
- `apps/api/src/repositories/drizzle/drizzleGiftRepository.ts` (new)
- `apps/api/src/repositories/paymentRepository.ts` (modify) — polymorphic + `getById`
- `apps/api/src/repositories/drizzle/drizzlePaymentRepository.ts` (modify)
- `apps/api/src/repositories/orderRepository.ts` (modify) — `OrderItemDTO.gift_id`
- `apps/api/src/repositories/drizzle/drizzleOrderRepository.ts` (modify)
- `apps/api/src/repositories/shared.ts` (modify) — `sharedGiftRepo`
- `apps/api/src/services/razorpay.ts` (modify) — `refund()` + `buildMockRefundWebhook()`
- `apps/api/src/services/payments.ts` (modify) — gift payment + refund webhook routing
- `apps/api/src/services/gift.ts` (new) — `GiftService`
- `apps/api/src/services/giftExpirySweep.ts` (new) — daily sweep
- `apps/api/src/services/ordering.ts` (modify) — gift lines in orders
- `apps/api/src/services/fulfillment.ts` (modify) — gift fulfill on pickup + release on cancel
- `apps/api/src/services/loyalty.ts` (modify) — `GiftFulfilled` → sender credit
- `apps/api/src/routes/gifts.ts` (new) — `/api/v1/gifts`
- `apps/api/src/routes/orders.ts` (modify) — accept `gift_id`
- `apps/api/src/routes/payments.ts` (modify) — pass gift repo
- `apps/api/src/routes/fulfillment.ts` (modify) — pass gift repo
- `apps/api/src/app.ts` (modify) — mount gifts router
- `apps/api/src/index.ts` (modify) — start sweep

**Consumer**
- `apps/consumer/lib/api.ts` (modify) — gift client functions + types
- `apps/consumer/lib/store.ts` (modify) — `CartItem.giftId`
- `apps/consumer/components/GiftModal.tsx` (new)
- `apps/consumer/components/GiftSuccess.tsx` (new)
- `apps/consumer/components/MenuItemsList.tsx` (modify) — gift action + picker wiring
- `apps/consumer/components/CartDrawer.tsx` (modify) — gift badge + release on remove
- `apps/consumer/app/gift/[token]/page.tsx` (new) — landing/claim page
- `apps/consumer/app/profile/page.tsx` (modify) — My Gifts section
- `apps/consumer/app/checkout/page.tsx` (modify) — pass `gift_id` when placing order

**Tests**
- `packages/db/src/schema.test.ts`, `apps/api/src/routes/gifts.test.ts`, `apps/api/src/services/giftExpirySweep.test.ts`, `apps/api/src/routes/orders.test.ts`, `apps/api/src/routes/fulfillment.test.ts`, `apps/api/src/services/loyalty.test.ts`, `apps/api/src/repositories/giftRepository.test.ts`, `apps/consumer/lib/__tests__/gifts.test.ts`, `apps/consumer/components/__tests__/GiftModal.test.tsx`, `apps/consumer/components/__tests__/GiftSuccess.test.tsx`, `apps/consumer/app/gift/__tests__/gift.test.tsx`, `apps/consumer/components/__tests__/CartDrawer.gift.test.tsx`

---

### Task 1: DB schema — gifts table + polymorphic payments + order_items.gift_id + typed events

**Files:**
- Create: `packages/db/src/schema/gifts.ts`
- Modify: `packages/db/src/schema/payments.ts`
- Modify: `packages/db/src/schema/ordering.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/types/src/events.ts`
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Produces: `gifts` table + `giftStatusEnum` (values `PENDING, ACTIVE, CLAIMED, FULFILLED, EXPIRED, REFUNDING, REFUNDED, CANCELLED`) + `GiftItemSnapshot`; `payments.gift_id` uuid column + `payments.order_id` nullable; `order_items.gift_id` uuid column; events `GiftPaid`, `GiftFulfilled`, `GiftExpired`, `GiftRefunded`.

- [ ] **Step 1: Write the failing migration assertions**

Append to `packages/db/src/schema.test.ts` (after the existing `describe` blocks):

```ts
describe("Social Gifting schema", () => {
  it("defines the gift_status enum", () => {
    expect(sql).toMatch(/CREATE TYPE "public"\."gift_status"/);
    for (const s of ["PENDING", "ACTIVE", "CLAIMED", "FULFILLED", "EXPIRED", "REFUNDING", "REFUNDED", "CANCELLED"]) {
      expect(sql).toMatch(new RegExp(s));
    }
  });

  it("defines the gifts table with token + code + expiry", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "gifts"/);
    expect(sql).toMatch(/"claim_token"/);
    expect(sql).toMatch(/"claim_code"/);
    expect(sql).toMatch(/"expires_at"/);
    expect(sql).toMatch(/"price_paid"/);
    expect(sql).toMatch(/"item_snapshot"/);
  });

  it("makes payments.order_id nullable and adds payments.gift_id", () => {
    expect(sql).toMatch(/"gift_id" uuid/);
    expect(sql).toMatch(/payments_order_id/);
    expect(sql).toMatch(/payments_gift_id_idx/);
  });

  it("adds order_items.gift_id", () => {
    expect(sql).toMatch(/"gift_id" uuid/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/db/src/schema.test.ts`
Expected: FAIL — the assertions for `gift_status`, `gifts`, `gift_id` are not in the migration SQL yet.

- [ ] **Step 3: Create the gifts schema**

Create `packages/db/src/schema/gifts.ts`:

```ts
import {
  decimal,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { menu_items, restaurants } from "./catalog";
import { users } from "./identity";
import { payments } from "./payments";

export const giftStatusEnum = pgEnum("gift_status", [
  "PENDING",
  "ACTIVE",
  "CLAIMED",
  "FULFILLED",
  "EXPIRED",
  "REFUNDING",
  "REFUNDED",
  "CANCELLED",
]);

/** Frozen copy of the sender's chosen configuration. */
export interface GiftItemSnapshot {
  name: string;
  price: number;
  image_url: string | null;
  dietary_tags: Record<string, boolean>;
  spice_level: number;
  customizations: { name: string; price_delta: number }[];
}

export const gifts = pgTable(
  "gifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sender_id: uuid("sender_id")
      .notNull()
      .references(() => users.id),
    restaurant_id: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    menu_item_id: uuid("menu_item_id")
      .notNull()
      .references(() => menu_items.id),
    item_snapshot: jsonb("item_snapshot").$type<GiftItemSnapshot>().notNull(),
    price_paid: decimal("price_paid", { precision: 10, scale: 2 }).notNull(),
    message: text("message"),
    recipient_name: text("recipient_name"),
    claim_token: text("claim_token").notNull().unique(),
    claim_code: text("claim_code").notNull(),
    status: giftStatusEnum("status").notNull().default("PENDING"),
    payment_id: uuid("payment_id").references(() => payments.id),
    claimed_by: uuid("claimed_by").references(() => users.id),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    fulfilled_at: timestamp("fulfilled_at", { withTimezone: true }),
    refunded_at: timestamp("refunded_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    senderIdx: index("gifts_sender_idx").on(table.sender_id),
    restaurantIdx: index("gifts_restaurant_idx").on(table.restaurant_id),
    statusIdx: index("gifts_status_idx").on(table.status),
  }),
);
```

- [ ] **Step 4: Make payments polymorphic**

In `packages/db/src/schema/payments.ts`:
- Change the `order_id` column from `.notNull().references(...)` to a nullable column with the FK removed from the column (keep it as a plain uuid + index):

```ts
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    order_id: uuid("order_id"),
    // Gift payments carry a gift_id instead of an order_id. The
    // exactly-one-of invariant is enforced in the payment repository/service.
    gift_id: uuid("gift_id"),
    provider: text("provider").notNull().default("razorpay"),
    provider_transaction_id: text("provider_transaction_id").notNull().unique(),
    amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("payments_order_idx").on(table.order_id),
    giftIdx: index("payments_gift_id_idx").on(table.gift_id),
    providerTxnIdx: index("payments_provider_txn_idx").on(
      table.provider_transaction_id,
    ),
  }),
);
```

Note: `import { orders } from "./ordering";` at the top is now unused — remove it to avoid a lint error.

- [ ] **Step 5: Add order_items.gift_id**

In `packages/db/src/schema/ordering.ts`, inside the `order_items` table definition add a column (after `item_subtotal`):

```ts
    item_subtotal: decimal("item_subtotal", { precision: 10, scale: 2 })
      .notNull(),
    // Redeemed gift id; a paid gift line is recorded at ₹0.
    gift_id: uuid("gift_id"),
```

- [ ] **Step 6: Export gifts**

In `packages/db/src/schema/index.ts`, add `export * from "./gifts";` (place it after the payments export line).

- [ ] **Step 7: Add typed gift events**

In `packages/types/src/events.ts`:

1. Add these names to the `EventNameSchema` enum (alphabetical, after `GroupOrderItemAdded`):

```ts
  "GiftPaid",
  "GiftFulfilled",
  "GiftExpired",
  "GiftRefunded",
```

2. Add payload schemas (before the `EventPayloadMap`):

```ts
// ============================================
// Social Gifting events
// ============================================

export const GiftPaidEventSchema = z.object({
  gift_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type GiftPaidEvent = z.infer<typeof GiftPaidEventSchema>;

export const GiftFulfilledEventSchema = z.object({
  gift_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  order_id: z.string().uuid(),
});
export type GiftFulfilledEvent = z.infer<typeof GiftFulfilledEventSchema>;

export const GiftExpiredEventSchema = z.object({
  gift_id: z.string().uuid(),
});
export type GiftExpiredEvent = z.infer<typeof GiftExpiredEventSchema>;

export const GiftRefundedEventSchema = z.object({
  gift_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  amount: z.number().nonnegative(),
});
export type GiftRefundedEvent = z.infer<typeof GiftRefundedEventSchema>;
```

3. Add to `EventPayloadMap`:

```ts
  GiftPaid: GiftPaidEvent;
  GiftFulfilled: GiftFulfilledEvent;
  GiftExpired: GiftExpiredEvent;
  GiftRefunded: GiftRefundedEvent;
```

- [ ] **Step 8: Regenerate the migration**

Run: `cd /workspace/packages/db && pnpm db:generate`
Expected: `drizzle-kit generate` writes a new `.sql` migration into `packages/db/drizzle/` containing `gift_status`, `gifts`, `payments.gift_id`, `order_items.gift_id`.

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/db/src/schema.test.ts`
Expected: PASS.

- [ ] **Step 10: Run typecheck for affected packages**

Run: `cd /workspace && pnpm --filter @snakzap/db typecheck && pnpm --filter @snakzap/types typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/schema/gifts.ts packages/db/src/schema/payments.ts packages/db/src/schema/ordering.ts packages/db/src/schema/index.ts packages/db/src/schema.test.ts packages/db/drizzle packages/types/src/events.ts
git commit -m "feat(db): add gifts table and polymorphic payments + gift events"
```

---

### Task 2: Gift repository (interface + Memory + Drizzle) + shared wiring

**Files:**
- Create: `apps/api/src/repositories/giftRepository.ts`
- Create: `apps/api/src/repositories/drizzle/drizzleGiftRepository.ts`
- Modify: `apps/api/src/repositories/shared.ts`
- Test: `apps/api/src/repositories/giftRepository.test.ts`

**Interfaces:**
- Consumes: `gifts`, `giftStatusEnum`, `GiftItemSnapshot` from `@snakzap/db`.
- Produces: `GiftStatus`, `GiftDTO`, `CreateGiftInput`, `GiftRepository` interface, `MemoryGiftRepository`, `DrizzleGiftRepository`, and `sharedGiftRepo`.

- [ ] **Step 1: Write the failing repository test**

Create `apps/api/src/repositories/giftRepository.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { MemoryGiftRepository } from "./giftRepository";
import type { CreateGiftInput, GiftDTO } from "./giftRepository";

function seed(repo: MemoryGiftRepository): GiftDTO {
  const input: CreateGiftInput & {
    claim_token: string;
    claim_code: string;
    expires_at: string;
  } = {
    sender_id: "11111111-1111-4111-8111-111111111111",
    restaurant_id: "22222222-2222-4222-8222-222222222222",
    menu_item_id: "33333333-3333-4333-8333-333333333333",
    item_snapshot: {
      name: "Paneer Wrap",
      price: 149,
      image_url: null,
      dietary_tags: { VEG: true },
      spice_level: 3,
      customizations: [{ name: "Extra Cheese", price_delta: 30 }],
    },
    price_paid: 179,
    message: "Enjoy!",
    recipient_name: "Ria",
    claim_token: "tok-abc",
    claim_code: "GIFT1234",
    expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
  };
  return repo.create(input);
}

describe("MemoryGiftRepository", () => {
  let repo: MemoryGiftRepository;

  beforeEach(() => {
    repo = new MemoryGiftRepository();
  });

  it("creates a PENDING gift and returns a GiftDTO", async () => {
    const gift = seed(repo);
    expect(gift.id).toBeTruthy();
    expect(gift.status).toBe("PENDING");
    expect(gift.price_paid).toBe(179);
    expect(gift.item_snapshot.name).toBe("Paneer Wrap");
  });

  it("finds a gift by claim token", async () => {
    const gift = seed(repo);
    const found = await repo.getByToken("tok-abc");
    expect(found?.id).toBe(gift.id);
  });

  it("marks a gift claimed and clears it on release", async () => {
    const gift = seed(repo);
    const claimed = await repo.markClaimed(gift.id, "44444444-4444-4444-8444-444444444444");
    expect(claimed?.status).toBe("CLAIMED");
    expect(claimed?.claimed_by).toBe("44444444-4444-4444-8444-444444444444");
    const released = await repo.release(gift.id);
    expect(released?.status).toBe("ACTIVE");
    expect(released?.claimed_by).toBeNull();
  });

  it("lists gifts due for expiry", async () => {
    const gift = seed(repo);
    await repo.updateStatus(gift.id, "ACTIVE");
    const due = await repo.listDueForExpiry(
      new Date(Date.now() + 91 * 24 * 3600_000).toISOString(),
    );
    expect(due.map((g) => g.id)).toContain(gift.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/repositories/giftRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the gift repository interface + Memory impl**

Create `apps/api/src/repositories/giftRepository.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { GiftItemSnapshot } from "@snakzap/db";

export type GiftStatus =
  | "PENDING"
  | "ACTIVE"
  | "CLAIMED"
  | "FULFILLED"
  | "EXPIRED"
  | "REFUNDING"
  | "REFUNDED"
  | "CANCELLED";

export interface GiftDTO {
  id: string;
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  item_snapshot: GiftItemSnapshot;
  price_paid: number;
  message: string | null;
  recipient_name: string | null;
  claim_token: string;
  claim_code: string;
  status: GiftStatus;
  payment_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  fulfilled_at: string | null;
  refunded_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateGiftInput {
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  item_snapshot: GiftItemSnapshot;
  price_paid: number;
  message: string | null;
  recipient_name: string | null;
  claim_token: string;
  claim_code: string;
  expires_at: string;
}

export interface GiftRepository {
  create(input: CreateGiftInput): Promise<GiftDTO>;
  getById(id: string): Promise<GiftDTO | null>;
  getByToken(token: string): Promise<GiftDTO | null>;
  getBySender(senderId: string): Promise<GiftDTO[]>;
  updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null>;
  markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null>;
  release(id: string): Promise<GiftDTO | null>;
  markFulfilled(id: string): Promise<GiftDTO | null>;
  markRefunded(id: string): Promise<GiftDTO | null>;
  listDueForExpiry(nowIso: string): Promise<GiftDTO[]>;
  _reset(): void;
}

export class MemoryGiftRepository implements GiftRepository {
  private gifts = new Map<string, GiftDTO>();

  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const now = new Date().toISOString();
    const gift: GiftDTO = {
      id: randomUUID(),
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: input.item_snapshot,
      price_paid: input.price_paid,
      message: input.message,
      recipient_name: input.recipient_name,
      claim_token: input.claim_token,
      claim_code: input.claim_code,
      status: "PENDING",
      payment_id: null,
      claimed_by: null,
      claimed_at: null,
      fulfilled_at: null,
      refunded_at: null,
      expires_at: input.expires_at,
      created_at: now,
      updated_at: now,
    };
    this.gifts.set(gift.id, gift);
    return gift;
  }

  async getById(id: string): Promise<GiftDTO | null> {
    return this.gifts.get(id) ?? null;
  }

  async getByToken(token: string): Promise<GiftDTO | null> {
    for (const g of this.gifts.values()) {
      if (g.claim_token === token) return g;
    }
    return null;
  }

  async getBySender(senderId: string): Promise<GiftDTO[]> {
    return [...this.gifts.values()]
      .filter((g) => g.sender_id === senderId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const updated = { ...gift, status, updated_at: new Date().toISOString() };
    this.gifts.set(id, updated);
    return updated;
  }

  async markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "CLAIMED" as const,
      claimed_by: claimedBy,
      claimed_at: now,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async release(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const now = new Date().toISOString();
    const updated = {
      ...gift,
      status: "ACTIVE" as const,
      claimed_by: null,
      claimed_at: null,
      updated_at: now,
    };
    this.gifts.set(id, updated);
    return updated;
  }

  async markFulfilled(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const now = new Date().toISOString();
    const updated = { ...gift, status: "FULFILLED" as const, fulfilled_at: now, updated_at: now };
    this.gifts.set(id, updated);
    return updated;
  }

  async markRefunded(id: string): Promise<GiftDTO | null> {
    const gift = this.gifts.get(id);
    if (!gift) return null;
    const now = new Date().toISOString();
    const updated = { ...gift, status: "REFUNDED" as const, refunded_at: now, updated_at: now };
    this.gifts.set(id, updated);
    return updated;
  }

  async listDueForExpiry(nowIso: string): Promise<GiftDTO[]> {
    const now = Date.parse(nowIso);
    return [...this.gifts.values()].filter((g) => {
      if (g.status === "FULFILLED" || g.status === "REFUNDED" || g.status === "CANCELLED") {
        return false;
      }
      return Date.parse(g.expires_at) <= now;
    });
  }

  _reset(): void {
    this.gifts.clear();
  }
}
```

- [ ] **Step 4: Create the Drizzle gift repository**

Create `apps/api/src/repositories/drizzle/drizzleGiftRepository.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { gifts } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  GiftRepository,
  GiftDTO,
  GiftStatus,
  CreateGiftInput,
} from "../giftRepository";

function mapGiftRow(row: Record<string, unknown>): GiftDTO {
  return {
    id: row.id as string,
    sender_id: row.sender_id as string,
    restaurant_id: row.restaurant_id as string,
    menu_item_id: row.menu_item_id as string,
    item_snapshot: row.item_snapshot as GiftDTO["item_snapshot"],
    price_paid: Number(row.price_paid),
    message: (row.message as string | null) ?? null,
    recipient_name: (row.recipient_name as string | null) ?? null,
    claim_token: row.claim_token as string,
    claim_code: row.claim_code as string,
    status: row.status as GiftStatus,
    payment_id: (row.payment_id as string | null) ?? null,
    claimed_by: (row.claimed_by as string | null) ?? null,
    claimed_at: (row.claimed_at as Date | null)
      ? (row.claimed_at as Date).toISOString()
      : null,
    fulfilled_at: (row.fulfilled_at as Date | null)
      ? (row.fulfilled_at as Date).toISOString()
      : null,
    refunded_at: (row.refunded_at as Date | null)
      ? (row.refunded_at as Date).toISOString()
      : null,
    expires_at: (row.expires_at as Date).toISOString(),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export class DrizzleGiftRepository implements GiftRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(gifts).values({
      id,
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: input.item_snapshot,
      price_paid: String(input.price_paid),
      message: input.message,
      recipient_name: input.recipient_name,
      claim_token: input.claim_token,
      claim_code: input.claim_code,
      status: "PENDING",
      expires_at: new Date(input.expires_at),
      created_at: now,
      updated_at: now,
    });
    const created = await this.getById(id);
    if (!created) throw new Error("gift_create_missing");
    return created;
  }

  async getById(id: string): Promise<GiftDTO | null> {
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.id, id))) as Record<string, unknown>[];
    return rows[0] ? mapGiftRow(rows[0]) : null;
  }

  async getByToken(token: string): Promise<GiftDTO | null> {
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.claim_token, token))) as Record<string, unknown>[];
    return rows[0] ? mapGiftRow(rows[0]) : null;
  }

  async getBySender(senderId: string): Promise<GiftDTO[]> {
    const rows = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.sender_id, senderId))) as Record<string, unknown>[];
    return rows.map(mapGiftRow);
  }

  async updateStatus(id: string, status: GiftStatus): Promise<GiftDTO | null> {
    await this.db
      .update(gifts)
      .set({ status, updated_at: new Date() })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async markClaimed(id: string, claimedBy: string): Promise<GiftDTO | null> {
    const now = new Date();
    await this.db
      .update(gifts)
      .set({ status: "CLAIMED", claimed_by: claimedBy, claimed_at: now, updated_at: now })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async release(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    await this.db
      .update(gifts)
      .set({ status: "ACTIVE", claimed_by: null, claimed_at: null, updated_at: now })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async markFulfilled(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    await this.db
      .update(gifts)
      .set({ status: "FULFILLED", fulfilled_at: now, updated_at: now })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async markRefunded(id: string): Promise<GiftDTO | null> {
    const now = new Date();
    await this.db
      .update(gifts)
      .set({ status: "REFUNDED", refunded_at: now, updated_at: now })
      .where(eq(gifts.id, id));
    return this.getById(id);
  }

  async listDueForExpiry(nowIso: string): Promise<GiftDTO[]> {
    const now = new Date(nowIso);
    const all = (await this.db
      .select()
      .from(gifts)
      .where(eq(gifts.status, "ACTIVE")) as Record<string, unknown>[])
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "CLAIMED"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "PENDING"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "REFUNDING"))) as Record<string, unknown>[],
      )
      .concat(
        (await this.db
          .select()
          .from(gifts)
          .where(eq(gifts.status, "EXPIRED"))) as Record<string, unknown>[],
      );
    return all
      .filter((r) => Date.parse((r.expires_at as Date).toISOString()) <= now.getTime())
      .map(mapGiftRow);
  }

  _reset(): void {
    // DB-backed repos don't support in-process reset; tests should use Memory repos.
  }
}
```

- [ ] **Step 5: Wire sharedGiftRepo**

In `apps/api/src/repositories/shared.ts`:

1. Add imports:
```ts
import type { GiftRepository } from "./giftRepository";
import { MemoryGiftRepository } from "./giftRepository";
import { DrizzleGiftRepository } from "./drizzle/drizzleGiftRepository";
```
2. Add to `RepoSet`:
```ts
  sharedGiftRepo: GiftRepository & { _reset(): void };
```
3. Add `sharedGiftRepo: new MemoryGiftRepository(),` in **all three** `_repos = { ... }` objects (memory branch, drizzle branch, drizzle catch branch).
4. Add `sharedGiftRepo: new DrizzleGiftRepository(db) as unknown as RepoSet["sharedGiftRepo"],` in the drizzle branch.
5. Add export at the bottom:
```ts
export const sharedGiftRepo = createLazyRepo("sharedGiftRepo");
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run apps/api/src/repositories/giftRepository.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/api typecheck && pnpm --filter @snakzap/api lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/repositories/giftRepository.ts apps/api/src/repositories/drizzle/drizzleGiftRepository.ts apps/api/src/repositories/shared.ts apps/api/src/repositories/giftRepository.test.ts
git commit -m "feat(api): add gift repository with memory and drizzle implementations"
```

---

### Task 3: Polymorphic payment repo + Razorpay refund + PaymentService gift path

**Files:**
- Modify: `apps/api/src/repositories/paymentRepository.ts`
- Modify: `apps/api/src/repositories/drizzle/drizzlePaymentRepository.ts`
- Modify: `apps/api/src/services/razorpay.ts`
- Modify: `apps/api/src/services/payments.ts`
- Modify: `apps/api/src/routes/payments.ts`
- Test: `apps/api/src/services/payments.gift.test.ts`

**Interfaces:**
- Consumes: `sharedGiftRepo` (Task 2), `razorpayService` (existing).
- Produces: `PaymentDTO.gift_id` + nullable `order_id`, `CreatePaymentInput.gift_id`, `PaymentRepository.getById`, `PaymentService.createGiftPayment(giftId)`, gift routing in `processWebhook`, refund webhook handling, `RazorpayService.refund(paymentId, amountPaise)`, `RazorpayService.buildMockRefundWebhook(paymentId, amount)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/payments.gift.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { PaymentService } from "./payments";
import { razorpayService } from "./razorpay";

describe("PaymentService gift path", () => {
  let paymentRepo: MemoryPaymentRepository;
  let orderRepo: MemoryOrderRepository;
  let giftRepo: MemoryGiftRepository;
  let service: PaymentService;

  beforeEach(() => {
    paymentRepo = new MemoryPaymentRepository();
    orderRepo = new MemoryOrderRepository();
    giftRepo = new MemoryGiftRepository();
    service = new PaymentService(paymentRepo, orderRepo, giftRepo);
    paymentRepo._reset();
    orderRepo._reset();
    giftRepo._reset();
  });

  it("creates a gift payment and activates the gift on captured webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: {
        name: "Samosa",
        price: 30,
        image_url: null,
        dietary_tags: { VEG: true },
        spice_level: 2,
        customizations: [],
      },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-1",
      claim_code: "ABC12345",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    expect(result.razorpay_order_id).toMatch(/^order_mock_/);
    expect(result.amount).toBe(30);

    const payment = await paymentRepo.getByGiftId(gift.id);
    expect(payment).not.toBeNull();

    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id,
      3000,
      "payment.captured",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("ACTIVE");

    const after = await giftRepo.getById(gift.id);
    expect(after?.status).toBe("ACTIVE");
  });

  it("leaves the gift PENDING on a failed payment webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-2",
      claim_code: "ABC12346",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    const webhook = razorpayService.buildMockWebhook(
      result.razorpay_order_id,
      3000,
      "payment.failed",
    );
    const processed = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(processed.giftStatus).toBe("PENDING");
    expect((await giftRepo.getById(gift.id))?.status).toBe("PENDING");
  });

  it("marks a gift REFUNDED on a refund webhook", async () => {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: "tok-3",
      claim_code: "ABC12347",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });

    const result = await service.createGiftPayment(gift.id);
    const captured = razorpayService.buildMockWebhook(result.razorpay_order_id, 3000, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);

    const payment = await paymentRepo.getByGiftId(gift.id);
    const refundWebhook = razorpayService.buildMockRefundWebhook(
      payment!.razorpay_payment_id!,
      3000,
    );
    const processed = await service.processWebhook(refundWebhook.rawBody, refundWebhook.signature);
    expect(processed.giftStatus).toBe("REFUNDED");
    expect((await giftRepo.getById(gift.id))?.status).toBe("REFUNDED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/services/payments.gift.test.ts`
Expected: FAIL — `getByGiftId` / `createGiftPayment` / `refund` / `buildMockRefundWebhook` do not exist.

- [ ] **Step 3: Make the payment repository polymorphic**

In `apps/api/src/repositories/paymentRepository.ts`:

1. Change `PaymentDTO`:
```ts
export interface PaymentDTO {
  id: string;
  order_id: string | null;
  gift_id: string | null;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  method: string | null;
  webhook_event: string | null;
  webhook_raw: unknown;
  created_at: string;
  updated_at: string;
}
```
2. Change `CreatePaymentInput`:
```ts
export interface CreatePaymentInput {
  order_id?: string | null;
  gift_id?: string | null;
  razorpay_order_id: string;
  amount: number;
  currency?: string;
  method?: string;
}
```
3. Add `getByGiftId` + `getById` to the interface:
```ts
  getById(id: string): Promise<PaymentDTO | null>;
  getByGiftId(giftId: string): Promise<PaymentDTO | null>;
```
4. In `MemoryPaymentRepository.create`, map `order_id: input.order_id ?? null, gift_id: input.gift_id ?? null`.
5. Add impls:
```ts
  async getById(id: string): Promise<PaymentDTO | null> {
    return this.payments.get(id) ?? null;
  }

  async getByGiftId(giftId: string): Promise<PaymentDTO | null> {
    for (const p of this.payments.values()) {
      if (p.gift_id === giftId) return p;
    }
    return null;
  }
```

- [ ] **Step 4: Update the Drizzle payment repository**

In `apps/api/src/repositories/drizzle/drizzlePaymentRepository.ts`:

1. In `mapPaymentRow`, add `gift_id: (row.gift_id as string | null) ?? null` and change `order_id: (row.order_id as string) ?? null`.
2. In `create`, set both `order_id: input.order_id ?? null` and `gift_id: input.gift_id ?? null` in the insert, and in the returned DTO.
3. Add:
```ts
  async getById(id: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id))) as Record<string, unknown>[];
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }

  async getByGiftId(giftId: string): Promise<PaymentDTO | null> {
    const rows = (await this.db
      .select()
      .from(payments)
      .where(eq(payments.gift_id, giftId))) as Record<string, unknown>[];
    return rows[0] ? mapPaymentRow(rows[0]) : null;
  }
```

- [ ] **Step 5: Add Razorpay refund support**

In `apps/api/src/services/razorpay.ts`, add methods to `RazorpayService`:

```ts
  async refund(paymentId: string, amountInPaise: number): Promise<{ id: string; status: string }> {
    if (MOCK_MODE) {
      return { id: `refund_mock_${randomUUID().slice(0, 8)}`, status: "processed" };
    }
    const auth = Buffer.from(
      `${config.razorpay.keyId}:${config.razorpay.keySecret}`,
    ).toString("base64");
    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: amountInPaise }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay refund failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  buildMockRefundWebhook(
    razorpayPaymentId: string,
    amountInPaise: number,
  ): { payload: { event: string; payload: { refund: { entity: { id: string; payment_id: string; amount: number; status: string } } } }; rawBody: string; signature: string } {
    const payload = {
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: `refund_mock_${randomUUID().slice(0, 8)}`,
            payment_id: razorpayPaymentId,
            amount: amountInPaise,
            status: "processed",
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = `valid_sig_${randomUUID().slice(0, 8)}`;
    return { payload, rawBody, signature };
  }
```

- [ ] **Step 6: Extend PaymentService**

In `apps/api/src/services/payments.ts`:

1. Update imports and constructor:
```ts
import type { GiftRepository } from "../repositories/giftRepository";
```
```ts
export class PaymentService {
  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly orderRepo: OrderRepository,
    private readonly giftRepo?: GiftRepository,
  ) {}
```
2. Add `createGiftPayment`:
```ts
  async createGiftPayment(giftId: string): Promise<{
    gift_id: string;
    razorpay_order_id: string;
    amount: number;
    currency: string;
  }> {
    if (!this.giftRepo) {
      throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
    }
    const gift = await this.giftRepo.getById(giftId);
    if (!gift) {
      throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    }
    if (gift.status !== "PENDING" && gift.status !== "ACTIVE") {
      throw new AppError(
        "GIFT_NOT_PAYABLE",
        `Gift is ${gift.status}, not payable`,
        400,
      );
    }

    const amountInPaise = Math.round(gift.price_paid * 100);
    const rpOrder = await razorpayService.createOrder(
      amountInPaise,
      `gift_${gift.id.slice(0, 8)}`,
    );

    await this.paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: rpOrder.id,
      amount: gift.price_paid,
    });

    return {
      gift_id: gift.id,
      razorpay_order_id: rpOrder.id,
      amount: gift.price_paid,
      currency: "INR",
    };
  }
```
3. Update the return type of `processWebhook` and add gift routing. Change the signature line to:
```ts
  async processWebhook(
    rawBody: string,
    signatureHeader: string,
  ): Promise<{
    processed: boolean;
    idempotent: boolean;
    orderStatus?: string;
    giftStatus?: string;
  }> {
```
4. Right after signature verification + JSON.parse, dispatch refund events before the payment-entity handling:
```ts
    if (payload.event === "refund.processed" || payload.event === "refund.cleared") {
      return this.processRefundWebhook(payload);
    }
```
5. After `const isCaptured = ...`, route gift payments:
```ts
    if (payment.gift_id) {
      const updated = await this.paymentRepo.updateWebhookResult(payment.id, {
        razorpay_payment_id: entity.id,
        status: isCaptured ? "CAPTURED" : "FAILED",
        method: entity.method ?? "unknown",
        webhook_event: payload.event,
        webhook_raw: payload,
      });
      if (!updated) {
        throw new AppError("PAYMENT_UPDATE_FAILED", "Failed to update payment record", 500);
      }
      if (isCaptured && this.giftRepo) {
        const gift = await this.giftRepo.updateStatus(payment.gift_id, "ACTIVE");
        await emit(
          createEventEnvelope("GiftPaid", payment.gift_id, {
            gift_id: payment.gift_id,
            payment_id: payment.id,
            amount: payment.amount,
          }),
        );
        return { processed: true, idempotent: false, giftStatus: gift?.status ?? "ACTIVE" };
      }
      return { processed: true, idempotent: false, giftStatus: "PENDING" };
    }
```
6. Add the refund handler method inside the class:
```ts
  private async processRefundWebhook(
    payload: { event: string; payload: { refund?: { entity?: { payment_id?: string; amount?: number } } } },
  ): Promise<{
    processed: boolean;
    idempotent: boolean;
    orderStatus?: string;
    giftStatus?: string;
  }> {
    const refundEntity = payload.payload?.refund?.entity;
    const razorpayPaymentId = refundEntity?.payment_id;
    if (!razorpayPaymentId) {
      throw new AppError("INVALID_WEBHOOK", "Malformed refund webhook: missing payment_id", 400);
    }

    const payment = await this.paymentRepo.findByRazorpayPaymentId(razorpayPaymentId);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "No payment record found for this refund", 404);
    }
    if (payment.status === "REFUNDED") {
      return { processed: false, idempotent: true };
    }

    await this.paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: razorpayPaymentId,
      status: "REFUNDED",
      method: payment.method ?? "unknown",
      webhook_event: payload.event,
      webhook_raw: payload,
    });

    if (payment.gift_id) {
      if (this.giftRepo) {
        const gift = await this.giftRepo.markRefunded(payment.gift_id);
        await emit(
          createEventEnvelope("GiftRefunded", payment.gift_id, {
            gift_id: payment.gift_id,
            sender_id: gift?.sender_id ?? "",
            amount: payment.amount,
          }),
        );
      }
      return { processed: true, idempotent: false, giftStatus: "REFUNDED" };
    }

    if (payment.order_id) {
      await this.orderRepo.updateStatus(payment.order_id, "REFUNDED");
    }
    return { processed: true, idempotent: false, orderStatus: "REFUNDED" };
  }
```
7. Add `getByGiftId` to the consumed `PaymentRepository` type is already done (Task step 3). The `processWebhook` must also find payment by razorpay order id for gift payments (existing `findByRazorpayOrderId` works regardless of gift/order).

- [ ] **Step 7: Update the payments route to pass the gift repo**

In `apps/api/src/routes/payments.ts`, change:
```ts
import { sharedGiftRepo, sharedOrderRepo, sharedPaymentRepo } from "../repositories/shared";
...
const paymentService = new PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo);
```
Also extend the webhook response:
```ts
    ok(res, {
      processed: result.processed,
      idempotent: result.idempotent,
      order_status: result.orderStatus,
      gift_status: result.giftStatus,
    });
```

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run apps/api/src/services/payments.gift.test.ts apps/api/src/routes/payments.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 9: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/api typecheck && pnpm --filter @snakzap/api lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/repositories/paymentRepository.ts apps/api/src/repositories/drizzle/drizzlePaymentRepository.ts apps/api/src/services/razorpay.ts apps/api/src/services/payments.ts apps/api/src/routes/payments.ts apps/api/src/services/payments.gift.test.ts
git commit -m "feat(api): polymorphic gift payments with refund webhook handling"
```

---

### Task 4: GiftService + gift routes + app wiring

**Files:**
- Create: `apps/api/src/services/gift.ts`
- Create: `apps/api/src/routes/gifts.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/gifts.test.ts`

**Interfaces:**
- Consumes: `sharedGiftRepo` (Task 2), `getCatalogRepository()` (existing), `PaymentService.createGiftPayment`, `razorpayService.refund`, `sharedPaymentRepo`.
- Produces: `GiftService` with `create`, `pay`, `cancel`, `getLanding`, `getMine`, `claim`, `release`, `requestRefund`; router `giftsRouter` mounted at `/api/v1/gifts`.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/gifts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { Express } from "express";
import type { Server } from "node:http";
import { listen } from "../testUtils";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";

let app: Express;
let server: Server;
let base: string;

beforeEach(async () => {
  sharedGiftRepo._reset();
  sharedPaymentRepo._reset();
  app = createApp();
  ({ server, base } = await listen(app));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /api/v1/gifts", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${base}/api/v1/gifts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/gifts/t/:token", () => {
  it("returns 404 for an unknown token", async () => {
    const res = await fetch(`${base}/api/v1/gifts/t/nope`);
    expect(res.status).toBe(404);
  });
});
```

Note: this test relies on a `testUtils.listen` helper. Check whether one exists (`apps/api/src/testUtils.ts` or similar); if not, use the existing pattern from another route test (`grep -l "listen(" apps/api/src/routes/*.test.ts | head -1` to copy how they start the server).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/routes/gifts.test.ts`
Expected: FAIL — `giftsRouter` not mounted (404 / module missing).

- [ ] **Step 3: Create GiftService**

Create `apps/api/src/services/gift.ts`:

```ts
import { randomBytes } from "node:crypto";
import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GiftRepository, GiftDTO, GiftStatus } from "../repositories/giftRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import { razorpayService } from "./razorpay";
import type { CustomizationDelta } from "./pricing";

export const GIFT_TTL_DAYS = 90;

export interface CreateGiftInput {
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  customizations: CustomizationDelta[];
  message?: string;
  recipient_name?: string;
}

export interface GiftLanding {
  gift: GiftDTO;
  restaurant: { name: string; image_url: string | null } | null;
  sender_display: string;
  claimable: boolean;
  claim_block_reason?: string;
}

export class GiftService {
  constructor(
    private readonly giftRepo: GiftRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  private async ensureGift(id: string): Promise<GiftDTO> {
    const gift = await this.giftRepo.getById(id);
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    return gift;
  }

  private async ensureGiftByToken(token: string): Promise<GiftDTO> {
    const gift = await this.giftRepo.getByToken(token);
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    return gift;
  }

  /** Price is always server-computed: base price + the sender's customization deltas. */
  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const restaurant = await this.catalogRepo.getRestaurantById(input.restaurant_id);
    if (!restaurant || !restaurant.is_active) {
      throw new AppError("RESTAURANT_NOT_FOUND", "Restaurant not found or inactive", 404);
    }
    const menuItem = await this.catalogRepo.getMenuItemById(input.menu_item_id);
    if (!menuItem || !menuItem.is_available) {
      throw new AppError("ITEM_NOT_FOUND", "Menu item not found or unavailable", 404);
    }
    if (menuItem.restaurant_id !== input.restaurant_id) {
      throw new AppError(
        "ITEM_RESTAURANT_MISMATCH",
        `Item ${input.menu_item_id} does not belong to restaurant ${input.restaurant_id}`,
        400,
      );
    }

    const customizationTotal = input.customizations.reduce((s, c) => s + c.price_delta, 0);
    const pricePaid = menuItem.price + customizationTotal;
    if (pricePaid <= 0) {
      throw new AppError("INVALID_PRICE", "Gift price must be positive", 400);
    }

    const claimToken = randomBytes(16).toString("hex");
    const claimCode = randomBytes(4).toString("hex").toUpperCase();

    return this.giftRepo.create({
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: {
        name: menuItem.name,
        price: menuItem.price,
        image_url: menuItem.image_url ?? null,
        dietary_tags: menuItem.dietary_tags ?? {},
        spice_level: menuItem.spice_level ?? 3,
        customizations: input.customizations.map((c) => ({ name: c.name, price_delta: c.price_delta })),
      },
      price_paid: pricePaid,
      message: input.message ?? null,
      recipient_name: input.recipient_name ?? null,
      claim_token: claimToken,
      claim_code: claimCode,
      expires_at: new Date(Date.now() + GIFT_TTL_DAYS * 24 * 3600_000).toISOString(),
    });
  }

  async getMine(senderId: string): Promise<GiftDTO[]> {
    return this.giftRepo.getBySender(senderId);
  }

  async getLanding(token: string, viewerId: string | null): Promise<GiftLanding> {
    const gift = await this.ensureGiftByToken(token);
    const restaurant = await this.catalogRepo.getRestaurantById(gift.restaurant_id);

    let claimable = false;
    let claimBlockReason: string | undefined;
    if (gift.status === "ACTIVE" && Date.parse(gift.expires_at) > Date.now()) {
      if (viewerId && viewerId === gift.sender_id) {
        claimBlockReason = "You cannot claim your own gift";
      } else if (gift.claimed_by && gift.claimed_by !== viewerId) {
        claimBlockReason = "This gift was already claimed";
      } else {
        claimable = true;
      }
    } else if (gift.status === "CLAIMED") {
      claimBlockReason = "This gift has already been claimed";
    } else if (gift.status === "FULFILLED") {
      claimBlockReason = "This gift has been fulfilled";
    } else if (gift.status === "EXPIRED") {
      claimBlockReason = "This gift has expired";
    } else if (gift.status === "REFUNDING" || gift.status === "REFUNDED") {
      claimBlockReason = "This gift has been refunded";
    } else if (gift.status === "CANCELLED") {
      claimBlockReason = "This gift was cancelled";
    } else if (Date.parse(gift.expires_at) <= Date.now()) {
      claimBlockReason = "This gift has expired";
    } else if (gift.status === "PENDING") {
      claimBlockReason = "This gift is still being sent";
    }

    return {
      gift,
      restaurant: restaurant ? { name: restaurant.name, image_url: restaurant.image_url ?? null } : null,
      sender_display: gift.recipient_name ? gift.recipient_name : "A friend",
      claimable,
      claim_block_reason: claimBlockReason,
    };
  }

  async claim(token: string, userId: string): Promise<GiftDTO> {
    const gift = await this.ensureGiftByToken(token);
    if (gift.sender_id === userId) {
      throw new AppError("SELF_GIFT", "You cannot claim your own gift", 400);
    }
    if (gift.status !== "ACTIVE") {
      throw new AppError("GIFT_NOT_CLAIMABLE", `Gift is ${gift.status}, not claimable`, 400);
    }
    if (Date.parse(gift.expires_at) <= Date.now()) {
      throw new AppError("GIFT_EXPIRED", "This gift has expired", 400);
    }
    const claimed = await this.giftRepo.markClaimed(gift.id, userId);
    if (!claimed) throw new AppError("CLAIM_FAILED", "Failed to claim gift", 500);
    return claimed;
  }

  async release(token: string, userId: string): Promise<GiftDTO> {
    const gift = await this.ensureGiftByToken(token);
    if (gift.status !== "CLAIMED" || gift.claimed_by !== userId) {
      throw new AppError("GIFT_NOT_RELEASABLE", "Gift is not claimed by this user", 400);
    }
    const released = await this.giftRepo.release(gift.id);
    if (!released) throw new AppError("RELEASE_FAILED", "Failed to release gift", 500);
    return released;
  }

  async cancel(giftId: string, senderId: string): Promise<GiftDTO> {
    const gift = await this.ensureGift(giftId);
    if (gift.sender_id !== senderId) {
      throw new AppError("FORBIDDEN", "Not your gift", 403);
    }
    if (gift.status === "PENDING") {
      const updated = await this.giftRepo.updateStatus(gift.id, "CANCELLED");
      if (!updated) throw new AppError("CANCEL_FAILED", "Failed to cancel gift", 500);
      return updated;
    }
    if (gift.status === "ACTIVE") {
      return this.requestRefund(gift);
    }
    throw new AppError(
      "GIFT_NOT_CANCELLABLE",
      `Gift is ${gift.status}, not cancellable`,
      400,
    );
  }

  /**
   * Submits a Razorpay refund for a paid gift. Used by sender-cancel and the
   * expiry sweep. The gift moves to REFUNDING and only becomes REFUNDED when
   * the Razorpay refund webhook confirms (see PaymentService.processWebhook).
   */
  async requestRefund(gift: GiftDTO): Promise<GiftDTO> {
    const updated = await this.giftRepo.updateStatus(gift.id, "REFUNDING");
    if (!updated) throw new AppError("REFUND_FAILED", "Failed to start refund", 500);

    const payment = await this.paymentRepo.getByGiftId(gift.id);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "No payment record for this gift", 404);
    }
    if (payment.status === "REFUNDED") {
      return this.giftRepo.markRefunded(gift.id) ?? updated;
    }
    if (!payment.razorpay_payment_id) {
      // Not yet captured (PENDING payment): nothing to refund; stay CANCELLED/EXPIRED.
      return updated;
    }
    try {
      await razorpayService.refund(payment.razorpay_payment_id, Math.round(gift.price_paid * 100));
    } catch {
      // Refund submission failed; keep REFUNDING so the sweep retries.
    }
    return updated;
  }
}
```

- [ ] **Step 4: Create the gifts router**

Create `apps/api/src/routes/gifts.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError, ok } from "../middleware/envelope";
import { authenticate } from "../middleware/auth";
import { getCatalogRepository } from "./catalog";
import {
  sharedGiftRepo,
  sharedPaymentRepo,
} from "../repositories/shared";
import { GiftService } from "../services/gift";
import { PaymentService } from "../services/payments";
import { sharedOrderRepo } from "../repositories/shared";

const CustomizationSchema = z.object({
  name: z.string().min(1).max(100),
  price_delta: z.number().default(0),
});

const CreateGiftSchema = z.object({
  restaurant_id: z.string().uuid(),
  menu_item_id: z.string().uuid(),
  customizations: z.array(CustomizationSchema).default([]),
  message: z.string().min(1).max(280).optional(),
  recipient_name: z.string().min(1).max(80).optional(),
});

const TokenParamSchema = z.object({
  token: z.string().min(1).max(128),
});

const GiftIdParamSchema = z.object({
  id: z.string().uuid(),
});

const giftService = new GiftService(sharedGiftRepo, sharedPaymentRepo, getCatalogRepository());
const paymentService = new PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo);

export const giftsRouter: Router = Router();

giftsRouter.post(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = CreateGiftSchema.safeParse(req.body);
    if (!body.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift request", 400, body.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.create({ sender_id: userId, ...body.data });
    const payment = await paymentService.createGiftPayment(gift.id);
    ok(res, { gift, ...payment }, 201);
  }),
);

giftsRouter.post(
  "/:id/pay",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = GiftIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift id", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.getMine(userId).then((list) =>
      list.find((g) => g.id === params.data.id),
    );
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    if (gift.status !== "PENDING") {
      throw new AppError("GIFT_NOT_PAYABLE", `Gift is ${gift.status}, not payable`, 400);
    }
    const payment = await paymentService.createGiftPayment(gift.id);
    ok(res, { gift, ...payment });
  }),
);

giftsRouter.post(
  "/:id/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = GiftIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid gift id", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const updated = await giftService.cancel(params.data.id, userId);
    ok(res, updated);
  }),
);

giftsRouter.get(
  "/mine",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    const gifts = await giftService.getMine(userId);
    ok(res, gifts);
  }),
);

giftsRouter.get(
  "/t/:token",
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const viewerId = (res.locals.userId as string | undefined) ?? null;
    const landing = await giftService.getLanding(params.data.token, viewerId);
    ok(res, landing);
  }),
);

giftsRouter.post(
  "/t/:token/claim",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.claim(params.data.token, userId);
    ok(res, gift);
  }),
);

giftsRouter.post(
  "/t/:token/release",
  authenticate,
  asyncHandler(async (req, res) => {
    const params = TokenParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid token", 400, params.error.flatten());
    }
    const userId = res.locals.userId as string;
    const gift = await giftService.release(params.data.token, userId);
    ok(res, gift);
  }),
);
```

- [ ] **Step 5: Mount the router**

In `apps/api/src/app.ts`, add the import:
```ts
import { giftsRouter } from "./routes/gifts";
```
and register (after `app.use(\`${API_PREFIX}/orders\`, cateringRouter);`):
```ts
  app.use(`${API_PREFIX}/gifts`, giftsRouter);
```

- [ ] **Step 6: Run the route test**

Run: `pnpm exec vitest run apps/api/src/routes/gifts.test.ts`
Expected: PASS (the two smoke tests). Full behavior coverage lands in the sweep task and final integration tests.

- [ ] **Step 7: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/api typecheck && pnpm --filter @snakzap/api lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/gift.ts apps/api/src/routes/gifts.ts apps/api/src/app.ts apps/api/src/routes/gifts.test.ts
git commit -m "feat(api): add gift service and gift routes"
```

---

### Task 5: Order integration — gift lines at ₹0 + pickup fulfillment + sender loyalty credit

**Files:**
- Modify: `apps/api/src/repositories/orderRepository.ts`
- Modify: `apps/api/src/repositories/drizzle/drizzleOrderRepository.ts`
- Modify: `apps/api/src/services/ordering.ts`
- Modify: `apps/api/src/routes/orders.ts`
- Modify: `apps/api/src/services/fulfillment.ts`
- Modify: `apps/api/src/routes/fulfillment.ts`
- Modify: `apps/api/src/services/loyalty.ts`
- Test: `apps/api/src/routes/orders.gift.test.ts`

**Interfaces:**
- Consumes: `sharedGiftRepo`, `GiftDTO` (Task 2), `GiftService` (Task 4).
- Produces: `OrderItemDTO.gift_id`, `PlaceOrderRequest.items[].gift_id`, `OrderingService` accepts `giftRepo`, `FulfillmentService` accepts `giftRepo` (fulfill gifts on pickup, release on cancel), `LoyaltyService.onGiftFulfilled`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/orders.gift.test.ts` (server + auth helpers copied from an existing route test — reuse the `listen` pattern; skip server-boilerplate here, it is identical to `gifts.test.ts`):

```ts
describe("POST /api/v1/orders with a gift line", () => {
  // Given: an ACTIVE gift claimed by the current user for restaurant R + item M.
  // Then: placeOrder with { menu_item_id: M, quantity: 1, gift_id: G } creates an
  // order whose item has base_price 0, gift_id G, and the order total excludes it.
  it("places an order with a ₹0 gift line", async () => {
    // full request round-trip: seed gift via sharedGiftRepo, claim via GiftService,
    // POST /api/v1/orders with gift_id, assert order.items[0].gift_id and total.
  });

  it("rejects a gift_id that is not claimed by this user", async () => {
    // expect 4xx with code ITEM_GIFT_MISMATCH
  });

  it("rejects a gift whose menu_item does not match the line", async () => {
    // expect 4xx ITEM_GIFT_MISMATCH
  });
});
```

Fill the three tests using the same auth helper your route tests already use (see `apps/api/src/routes/orders.test.ts` for how it authenticates a request — copy that pattern; the seed data comes from `SEED_MENU` / `catalogSeed` used by existing tests).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/api/src/routes/orders.gift.test.ts`
Expected: FAIL — `gift_id` is not accepted on order items (validation strips it / ignored) and the item is charged at full price.

- [ ] **Step 3: Add gift_id to the order item DTO + repos**

In `apps/api/src/repositories/orderRepository.ts`, add to `OrderItemDTO`:
```ts
  /** Set when the line is a redeemed ₹0 gift. */
  gift_id: string | null;
```
Update `MemoryOrderRepository.create` mapping is automatic (`...item` spread carries it).

In `apps/api/src/repositories/drizzle/drizzleOrderRepository.ts`:
- `mapOrderItemRow`: add `gift_id: (row.gift_id as string | null) ?? null`.
- `create` insert: add `gift_id: item.gift_id`; and to the returned item object add `gift_id: item.gift_id`.
- `setItems` insert: add `gift_id: item.gift_id`; returned push uses `{ id: itemId, ...item }` so it carries automatically.
- `_seed` item insert: add `gift_id: item.gift_id ?? null`.

- [ ] **Step 4: Update OrderingService to accept gift lines**

In `apps/api/src/services/ordering.ts`:

1. Add import + constructor param:
```ts
import type { GiftRepository } from "../repositories/giftRepository";
```
```ts
export class OrderingService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository,
    private readonly giftRepo?: GiftRepository,
  ) {}
```
2. Extend the item type:
```ts
  items: {
    menu_item_id: string;
    quantity: number;
    customizations: CustomizationDelta[];
    gift_id?: string;
  }[];
```
3. In `placeOrder`, handle gift lines. Replace the per-item loop body with:

```ts
      let basePrice = menuItem.price;
      let customizations = item.customizations;
      let giftId: string | null = null;

      if (item.gift_id) {
        if (!this.giftRepo) {
          throw new AppError("GIFT_REPO_MISSING", "Gift repository is not configured", 500);
        }
        const gift = await this.giftRepo.getById(item.gift_id);
        if (!gift) {
          throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
        }
        if (gift.status !== "CLAIMED" || gift.claimed_by !== request.user_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} is not claimed by this user`,
            400,
          );
        }
        if (gift.restaurant_id !== request.restaurant_id || gift.menu_item_id !== item.menu_item_id) {
          throw new AppError(
            "ITEM_GIFT_MISMATCH",
            `Gift ${gift.id} does not match the requested item or restaurant`,
            400,
          );
        }
        if (Date.parse(gift.expires_at) <= Date.now()) {
          throw new AppError("GIFT_EXPIRED", "This gift has expired", 400);
        }
        basePrice = 0;
        customizations = gift.item_snapshot.customizations;
        giftId = gift.id;
      }

      orderItems.push({
        menu_item_id: item.menu_item_id,
        name: menuItem.name,
        base_price: basePrice,
        quantity: item.quantity,
        customizations,
        gift_id: giftId,
      });
```

4. Map `gift_id` through the `CreateOrderInput` item mapping in `placeOrder`:
```ts
      items: orderItems.map((oi) => ({
        menu_item_id: oi.menu_item_id,
        name: oi.name,
        base_price: oi.base_price,
        quantity: oi.quantity,
        customizations: oi.customizations,
        gift_id: oi.gift_id,
        customization_total:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.customization_total ?? 0,
        item_subtotal:
          breakdown.items.find((b) => b.menu_item_id === oi.menu_item_id)
            ?.item_subtotal ?? 0,
      })),
```
5. In `reorder`, pass through `gift_id` when re-mapping items (gift lines are not reorderable — set `gift_id: undefined`):
```ts
    const items = oldOrder.items.map((item) => ({
      menu_item_id: item.menu_item_id,
      quantity: item.quantity,
      customizations: item.customizations,
      gift_id: undefined,
    }));
```
6. Update call sites that construct `OrderingService`:
- `apps/api/src/routes/orders.ts`: `new OrderingService(sharedOrderRepo, getCatalogRepository(), sharedGiftRepo)` (+ add `sharedGiftRepo` import).
- `apps/api/src/routes/wear.ts`: pass `sharedGiftRepo` as third arg (add import).
- `apps/api/src/services/posPetpooja.ts`: pass `null as never` is NOT ok — pass the third param only if a gift repo is available; the constructor param is optional so leaving it unchanged is fine. Do NOT modify posPetpooja.ts.
- `apps/api/src/routes/orders.ts` also needs `gift_id` in `OrderItemSchema`:
```ts
const OrderItemSchema = z.object({
  menu_item_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(50),
  customizations: z.array(CustomizationSchema).default([]),
  gift_id: z.string().uuid().optional(),
});
```

- [ ] **Step 5: Fulfill gifts on pickup + release on cancel**

In `apps/api/src/services/fulfillment.ts`:

1. Add imports + constructor param:
```ts
import type { GiftRepository } from "../repositories/giftRepository";
import type { OrderDTO } from "../repositories/orderRepository";
```
```ts
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly giftRepo?: GiftRepository,
  ) {}
```
2. In `confirmPickup`, after `await emit(createEventEnvelope("OrderPickedUp", ...))`, add gift fulfillment:
```ts
    await this.fulfillGifts(updated);
```
3. Add the helper method:
```ts
  private async fulfillGifts(order: OrderDTO): Promise<void> {
    if (!this.giftRepo) return;
    const giftLines = order.items.filter((i) => i.gift_id);
    for (const line of giftLines) {
      const giftId = line.gift_id;
      if (!giftId) continue;
      const gift = await this.giftRepo.markFulfilled(giftId);
      if (!gift) continue;
      await emit(
        createEventEnvelope("GiftFulfilled", giftId, {
          gift_id: giftId,
          sender_id: gift.sender_id,
          restaurant_id: gift.restaurant_id,
          order_id: order.id,
        }),
      );
    }
  }
```
4. In `cancelOrder`, after `await publishStatusUpdate(...)`, release gift lines:
```ts
    if (this.giftRepo) {
      const giftLines = order.items.filter((i) => i.gift_id);
      for (const line of giftLines) {
        if (line.gift_id) await this.giftRepo.release(line.gift_id);
      }
    }
```
5. Update `apps/api/src/routes/fulfillment.ts` line 36:
```ts
import { sharedGiftRepo } from "../repositories/shared";
...
const fulfillmentService = new FulfillmentService(sharedOrderRepo, sharedGiftRepo);
```

- [ ] **Step 6: Credit the sender on GiftFulfilled**

In `apps/api/src/services/loyalty.ts`, add a method on `LoyaltyService` (mirror `onOrderPickedUp` but for the sender) and register the handler:

```ts
  /**
   * GiftFulfilled hook. The SENDER earns the stamp for a gifted pickup
   * (recipient does not double-dip with their own paid items).
   */
  async onGiftFulfilled(event: {
    gift_id: string;
    sender_id: string;
    restaurant_id: string;
  }): Promise<StampCard | null> {
    const before = await this.repo.getStampCard(event.sender_id, event.restaurant_id);
    const { card, reward_unlocked } = await this.repo.incrementStamp(
      event.sender_id,
      event.restaurant_id,
    );

    await sharedAuditRepo.log(event.sender_id, "gift_stamp_incremented", {
      gift_id: event.gift_id,
      restaurant_id: event.restaurant_id,
      stamp_count: card.stamp_count,
      total_orders: card.total_orders,
      reward_unlocked,
    });

    if (reward_unlocked) {
      await emit(
        createEventEnvelope("StampCardRewardUnlocked", event.sender_id, {
          user_id: event.sender_id,
          restaurant_id: event.restaurant_id,
          reward_type: "FREE_ITEM",
          stamp_count_before: before?.stamp_count ?? STAMP_CARD_SIZE,
          rewards_earned: card.rewards_earned,
        }),
      );
    }

    return card;
  }
```
In `registerLoyaltyEventHandlers()`, add:
```ts
  onEvent("GiftFulfilled", async (event) => {
    const payload = event.payload as {
      gift_id: string;
      sender_id: string;
      restaurant_id: string;
    };
    await loyaltyService.onGiftFulfilled(payload);
  });
```

- [ ] **Step 7: Run the tests**

Run: `pnpm exec vitest run apps/api/src/routes/orders.gift.test.ts apps/api/src/routes/orders.test.ts apps/api/src/routes/fulfillment.test.ts apps/api/src/services/loyalty.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 8: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/api typecheck && pnpm --filter @snakzap/api lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/repositories/orderRepository.ts apps/api/src/repositories/drizzle/drizzleOrderRepository.ts apps/api/src/services/ordering.ts apps/api/src/routes/orders.ts apps/api/src/services/fulfillment.ts apps/api/src/routes/fulfillment.ts apps/api/src/services/loyalty.ts apps/api/src/routes/wear.ts apps/api/src/routes/orders.gift.test.ts
git commit -m "feat(api): gift lines in orders with pickup fulfillment and sender loyalty credit"
```

---

### Task 6: Gift expiry sweep + refund orchestration + boot wiring

**Files:**
- Create: `apps/api/src/services/giftExpirySweep.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/services/giftExpirySweep.test.ts`

**Interfaces:**
- Consumes: `sharedGiftRepo`, `sharedPaymentRepo`, `GiftService.requestRefund` (Task 4), `razorpayService.refund`.
- Produces: `runGiftExpirySweep(): Promise<{ expired: number; refunded: number; failed: number }>` and `startGiftExpirySweep(intervalMs)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/giftExpirySweep.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { runGiftExpirySweep } from "./giftExpirySweep";
import type { GiftDTO } from "../repositories/giftRepository";

function seedGift(repo: MemoryGiftRepository, daysFromNow: number, status: GiftDTO["status"]): GiftDTO {
  const expires = new Date(Date.now() + daysFromNow * 24 * 3600_000).toISOString();
  return repo.create({
    sender_id: "11111111-1111-4111-8111-111111111111",
    restaurant_id: "22222222-2222-4222-8222-222222222222",
    menu_item_id: "33333333-3333-4333-8333-333333333333",
    item_snapshot: { name: "Samosa", price: 30, image_url: null, dietary_tags: {}, spice_level: 1, customizations: [] },
    price_paid: 30,
    message: null,
    recipient_name: null,
    claim_token: `tok-${Math.random()}`,
    claim_code: "ABCD1234",
    expires_at: expires,
  }).then(async (g) => {
    const updated = await repo.updateStatus(g.id, status);
    return updated!;
  });
}

describe("runGiftExpirySweep", () => {
  let giftRepo: MemoryGiftRepository;
  let paymentRepo: MemoryPaymentRepository;

  beforeEach(() => {
    giftRepo = new MemoryGiftRepository();
    paymentRepo = new MemoryPaymentRepository();
  });

  it("expires ACTIVE gifts past their expiry date", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(1);
    expect((await giftRepo.getById(gift.id))?.status).toBe("EXPIRED");
  });

  it("moves an expired paid gift to REFUNDING and requests a refund", async () => {
    const gift = await seedGift(giftRepo, -1, "ACTIVE");
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: "order_mock_paid",
      amount: 30,
    });
    // A captured payment carries a razorpay_payment_id; the sweep only refunds
    // payments that were actually captured (matches production semantics).
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: "pay_mock_paid",
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.refunded).toBe(1);
    const after = await giftRepo.getById(gift.id);
    expect(after?.status).toBe("REFUNDING");
  });

  it("leaves unexpired gifts alone", async () => {
    const gift = await seedGift(giftRepo, 10, "ACTIVE");
    const result = await runGiftExpirySweep(giftRepo, paymentRepo, new Date());
    expect(result.expired).toBe(0);
    expect((await giftRepo.getById(gift.id))?.status).toBe("ACTIVE");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run apps/api/src/services/giftExpirySweep.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the sweep**

Create `apps/api/src/services/giftExpirySweep.ts`:

```ts
import { createEventEnvelope, emit } from "../lib/eventBus";
import { logger } from "../lib/logger";
import type { GiftRepository, GiftDTO } from "../repositories/giftRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import { razorpayService } from "./razorpay";
import { sharedGiftRepo, sharedPaymentRepo } from "../repositories/shared";

export interface SweepResult {
  expired: number;
  refunded: number;
  failed: number;
}

/**
 * Daily expiry + refund sweep. Gifts that are ACTIVE/CLAIMED/PENDING past
 * their expires_at become EXPIRED. Paid gifts (payment CAPTURED, not yet
 * REFUNDED) move to REFUNDING and a Razorpay refund is submitted; the gift
 * only reaches REFUNDED when the refund webhook confirms. Failed refund
 * submissions stay REFUNDING and are retried on the next sweep.
 */
export async function runGiftExpirySweep(
  giftRepo: GiftRepository,
  paymentRepo: PaymentRepository,
  now: Date = new Date(),
): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, refunded: 0, failed: 0 };
  const due = await giftRepo.listDueForExpiry(now.toISOString());

  for (const gift of due) {
    try {
      if (gift.status === "ACTIVE" || gift.status === "CLAIMED" || gift.status === "PENDING") {
        await giftRepo.updateStatus(gift.id, "EXPIRED");
        result.expired += 1;
        await emit(
          createEventEnvelope("GiftExpired", gift.id, { gift_id: gift.id }),
        );
      }

      const payment = await paymentRepo.getByGiftId(gift.id);
      if (!payment) continue;
      if (payment.status === "REFUNDED") continue;
      if (!payment.razorpay_payment_id) continue;

      await giftRepo.updateStatus(gift.id, "REFUNDING");
      await razorpayService.refund(
        payment.razorpay_payment_id,
        Math.round(gift.price_paid * 100),
      );
      result.refunded += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({
        message: "gift_expiry_sweep_item_failed",
        gift_id: gift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

/** Boot wiring: run immediately, then on the given interval (default 24h). */
export function startGiftExpirySweep(intervalMs = 24 * 60 * 60 * 1000): void {
  void runGiftExpirySweep(sharedGiftRepo, sharedPaymentRepo);
  timer = setInterval(() => {
    void runGiftExpirySweep(sharedGiftRepo, sharedPaymentRepo);
  }, intervalMs);
  timer.unref();
}

export function stopGiftExpirySweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
```

- [ ] **Step 4: Wire the sweep at boot**

In `apps/api/src/index.ts`, inside `main()` after `seedCatalogData()` and before `initWebSocketServer(server)`:

```ts
  // Daily gift expiry + refund sweep (social gifting). Unref'd timer so it
  // never keeps the process alive.
  const { startGiftExpirySweep } = await import("./services/giftExpirySweep");
  startGiftExpirySweep();
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run apps/api/src/services/giftExpirySweep.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/api typecheck && pnpm --filter @snakzap/api lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/giftExpirySweep.ts apps/api/src/index.ts apps/api/src/services/giftExpirySweep.test.ts
git commit -m "feat(api): daily gift expiry sweep with refund orchestration"
```

---

### Task 7: Consumer API client + cart gift support

**Files:**
- Modify: `apps/consumer/lib/api.ts`
- Modify: `apps/consumer/lib/store.ts`
- Test: `apps/consumer/lib/__tests__/gifts.test.ts`

**Interfaces:**
- Consumes: backend payload shapes (Tasks 4-5).
- Produces: `GiftStatus`, `GiftItemSnapshot`, `Gift`, `GiftLanding`, `CreateGiftResult`, `createGift`, `retryGiftPayment`, `cancelGift`, `fetchMyGifts`, `fetchGiftLanding`, `claimGift`, `releaseGift`; `CartItem.giftId`.

- [ ] **Step 1: Write the failing client tests**

Create `apps/consumer/lib/__tests__/gifts.test.ts` (mirror the pattern of `apps/vendor/lib/__tests__/api.test.ts` — mock global fetch):

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { createGift, claimGift, fetchGiftLanding } from "../api";

const TOKEN = "t";

function mockFetch(data: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => ({ success: ok, data, error: ok ? null : { code: "X", message: "boom" } }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gifting api client", () => {
  it("createGift POSTs the sender payload", async () => {
    mockFetch({ gift: { id: "g1" }, razorpay_order_id: "order_x", amount: 149 });
    const result = await createGift(TOKEN, {
      restaurant_id: "r1",
      menu_item_id: "m1",
      customizations: [{ name: "Extra", price_delta: 10 }],
      message: "Enjoy",
      recipient_name: "Ria",
    });
    expect(result.gift.id).toBe("g1");
    const call = vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/gifts");
    expect(JSON.parse(String(call[1].body))).toMatchObject({ restaurant_id: "r1", recipient_name: "Ria" });
  });

  it("claimGift POSTs to the claim endpoint", async () => {
    mockFetch({ id: "g1", status: "CLAIMED" });
    const gift = await claimGift(TOKEN, "tok123");
    expect(gift.status).toBe("CLAIMED");
    const call = vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/api/v1/gifts/t/tok123/claim");
    expect(call[1].method).toBe("POST");
  });

  it("fetchGiftLanding is public (no auth header)", async () => {
    mockFetch({ gift: { id: "g1", status: "ACTIVE" }, restaurant: null, sender_display: "A friend", claimable: true });
    const landing = await fetchGiftLanding("tok123");
    expect(landing.claimable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @snakzap/consumer exec vitest run lib/__tests__/gifts.test.ts`
Expected: FAIL — functions do not exist.

- [ ] **Step 3: Add the gifting client**

In `apps/consumer/lib/api.ts`, add (after the group-order section):

```ts
// ============================================
// Social Gifting (Phase 5) - send a menu item to a friend via link + code
// ============================================

export type GiftStatus =
  | "PENDING"
  | "ACTIVE"
  | "CLAIMED"
  | "FULFILLED"
  | "EXPIRED"
  | "REFUNDING"
  | "REFUNDED"
  | "CANCELLED";

export interface GiftItemSnapshot {
  name: string;
  price: number;
  image_url: string | null;
  dietary_tags: Record<string, boolean>;
  spice_level: number;
  customizations: { name: string; price_delta: number }[];
}

export interface Gift {
  id: string;
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  item_snapshot: GiftItemSnapshot;
  price_paid: number;
  message: string | null;
  recipient_name: string | null;
  claim_token: string;
  claim_code: string;
  status: GiftStatus;
  payment_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  fulfilled_at: string | null;
  refunded_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface GiftLanding {
  gift: Gift;
  restaurant: { name: string; image_url: string | null } | null;
  sender_display: string;
  claimable: boolean;
  claim_block_reason?: string;
}

export interface CreateGiftResult {
  gift: Gift;
  razorpay_order_id: string;
  amount: number;
  currency: string;
}

export function createGift(
  token: string,
  input: {
    restaurant_id: string;
    menu_item_id: string;
    customizations: { name: string; price_delta: number }[];
    message?: string;
    recipient_name?: string;
  },
): Promise<CreateGiftResult> {
  return authedFetcher<CreateGiftResult>("/api/v1/gifts", token, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryGiftPayment(token: string, giftId: string): Promise<CreateGiftResult> {
  return authedFetcher<CreateGiftResult>(`/api/v1/gifts/${encodeURIComponent(giftId)}/pay`, token, {
    method: "POST",
  });
}

export function cancelGift(token: string, giftId: string): Promise<Gift> {
  return authedFetcher<Gift>(`/api/v1/gifts/${encodeURIComponent(giftId)}/cancel`, token, {
    method: "POST",
  });
}

export function fetchMyGifts(token: string): Promise<Gift[]> {
  return authedFetcher<Gift[]>("/api/v1/gifts/mine", token);
}

export function fetchGiftLanding(claimToken: string): Promise<GiftLanding> {
  return fetcher<GiftLanding>(`/api/v1/gifts/t/${encodeURIComponent(claimToken)}`);
}

export function claimGift(token: string, claimToken: string): Promise<Gift> {
  return authedFetcher<Gift>(`/api/v1/gifts/t/${encodeURIComponent(claimToken)}/claim`, token, {
    method: "POST",
  });
}

export function releaseGift(token: string, claimToken: string): Promise<Gift> {
  return authedFetcher<Gift>(`/api/v1/gifts/t/${encodeURIComponent(claimToken)}/release`, token, {
    method: "POST",
  });
}
```

- [ ] **Step 4: Add giftId to the cart store**

In `apps/consumer/lib/store.ts`:

1. Add to `CartItem`:
```ts
  /** Set on a redeemed ₹0 gift line; quantity is locked to 1. */
  giftId?: string;
```
2. In `persistCurrent`, pass `gift_id`:
```ts
    items: items.map((i) => ({
      menu_item_id: i.menuItemId,
      quantity: i.quantity,
      name: i.name,
      base_price: i.basePrice,
      customizations: i.customizations,
      restaurant_id: i.restaurantId,
      gift_id: i.giftId,
    })),
```
3. In `hydrateFromServer`, map it back:
```ts
      items: saved.items.map((i) => ({
        menuItemId: i.menu_item_id,
        name: i.name ?? `Item ${i.menu_item_id.slice(0, 8)}`,
        basePrice: i.base_price ?? 0,
        quantity: i.quantity,
        customizations: i.customizations ?? [],
        restaurantId: i.restaurant_id ?? saved.restaurant_id ?? "",
        giftId: (i as { gift_id?: string | null }).gift_id ?? undefined,
      })),
```
4. In `apps/consumer/lib/api.ts`, extend `PersistedCartItem` with `gift_id?: string | null;`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @snakzap/consumer exec vitest run lib/__tests__/gifts.test.ts lib/__tests__/store.test.ts`
Expected: PASS (new + existing store tests, which may need a tiny update if they construct full `CartItem` literals — make `giftId` optional so existing literals compile).

- [ ] **Step 6: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/consumer typecheck && pnpm --filter @snakzap/consumer lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/consumer/lib/api.ts apps/consumer/lib/store.ts apps/consumer/lib/__tests__/gifts.test.ts
git commit -m "feat(consumer): gifting api client and cart gift line support"
```

---

### Task 8: GiftModal + GiftSuccess + menu gift action

**Files:**
- Create: `apps/consumer/components/GiftModal.tsx`
- Create: `apps/consumer/components/GiftSuccess.tsx`
- Modify: `apps/consumer/components/MenuItemsList.tsx`
- Test: `apps/consumer/components/__tests__/GiftModal.test.tsx`
- Test: `apps/consumer/components/__tests__/GiftSuccess.test.tsx`

**Interfaces:**
- Consumes: `createGift`, `retryGiftPayment`, `cancelGift` (Task 7), `loadRazorpayScript`/`createRazorpayInstance` from `@/lib/razorpay`, `simulatePaymentWebhook` (existing), `formatINR` from `@/lib/pricing`.
- Produces: default-export `GiftModal`, `GiftSuccess`.

- [ ] **Step 1: Write the failing component tests**

Create `apps/consumer/components/__tests__/GiftModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GiftModal from "../GiftModal";
import { createGift, simulatePaymentWebhook } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import type { MenuItem } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createGift: vi.fn(),
    simulatePaymentWebhook: vi.fn(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/razorpay", () => ({
  loadRazorpayScript: vi.fn().mockResolvedValue(true),
  createRazorpayInstance: vi.fn(() => ({ open: vi.fn() })),
}));

const ITEM: MenuItem = {
  id: "m1",
  name: "Paneer Wrap",
  price: 149,
  image_url: null,
  dietary_tags: { VEG: true },
  spice_level: 3,
  customizations: [{ name: "Extra Cheese", price_delta: 30 }],
  is_available: true,
} as MenuItem;

describe("GiftModal", () => {
  it("renders item summary and validates empty message submission", async () => {
    render(<GiftModal restaurantId="r1" item={ITEM} customizations={[{ name: "Extra Cheese", price_delta: 30 }]} onPaid={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Gift this item")).toBeTruthy();
    const button = screen.getByRole("button", { name: /Pay & Send/ });
    expect(button).toBeTruthy();
    expect(screen.getByText("179")).toBeTruthy(); // 149 + 30
  });

  it("calls createGift and opens Razorpay on submit", async () => {
    vi.mocked(createGift).mockResolvedValue({
      gift: { id: "g1", claim_token: "tok1" } as never,
      razorpay_order_id: "order_x",
      amount: 179,
      currency: "INR",
    });
    vi.mocked(simulatePaymentWebhook).mockResolvedValue({ orderStatus: "ACTIVE" });
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true });

    render(<GiftModal restaurantId="r1" item={ITEM} customizations={[{ name: "Extra Cheese", price_delta: 30 }]} onPaid={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Pay & Send/ }));

    await waitFor(() => {
      expect(createGift).toHaveBeenCalled();
    });
  });
});
```

Create `apps/consumer/components/__tests__/GiftSuccess.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import GiftSuccess from "../GiftSuccess";
import type { Gift } from "@/lib/api";

const GIFT: Gift = {
  id: "g1",
  sender_id: "s1",
  restaurant_id: "r1",
  menu_item_id: "m1",
  item_snapshot: { name: "Paneer Wrap", price: 149, image_url: null, dietary_tags: {}, spice_level: 3, customizations: [] },
  price_paid: 149,
  message: null,
  recipient_name: null,
  claim_token: "tok1",
  claim_code: "GIFT1234",
  status: "ACTIVE",
  payment_id: null,
  claimed_by: null,
  claimed_at: null,
  fulfilled_at: null,
  refunded_at: null,
  expires_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as Gift;

describe("GiftSuccess", () => {
  it("renders the shareable link and code", () => {
    render(<GiftSuccess gift={GIFT} />);
    expect(screen.getByText("GIFT1234")).toBeTruthy();
    expect(screen.getByText(/gift\/tok1/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @snakzap/consumer exec vitest run components/__tests__/GiftModal.test.tsx components/__tests__/GiftSuccess.test.tsx`
Expected: FAIL — components do not exist.

- [ ] **Step 3: Create GiftModal**

Create `apps/consumer/components/GiftModal.tsx`:

```tsx
"use client";

import { useState } from "react";
import { GiftIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { createGift, simulatePaymentWebhook, type Gift, type MenuItem } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { loadRazorpayScript, createRazorpayInstance } from "@/lib/razorpay";
import { formatINR } from "@/lib/pricing";
import { GiftSuccess } from "./GiftSuccess";

export default function GiftModal({
  restaurantId,
  item,
  customizations,
  onPaid,
  onClose,
}: {
  restaurantId: string;
  item: MenuItem;
  customizations: { name: string; price_delta: number }[];
  onPaid: (gift: Gift) => void;
  onClose: () => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);

  const customizationTotal = customizations.reduce((s, c) => s + c.price_delta, 0);
  const amount = item.price + customizationTotal;

  async function handlePay() {
    if (!accessToken) return;
    setError("");
    setPaying(true);
    try {
      const result = await createGift(accessToken, {
        restaurant_id: restaurantId,
        menu_item_id: item.id,
        customizations,
        message: message.trim() || undefined,
        recipient_name: recipientName.trim() || undefined,
      });

      const loaded = await loadRazorpayScript();
      if (!loaded) {
        setError("Failed to load payment gateway");
        setPaying(false);
        return;
      }

      const rzp = createRazorpayInstance({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "rzp_test_placeholder",
        amount: result.amount * 100,
        currency: "INR",
        name: "SnakZap",
        description: `Gift: ${item.name}`,
        order_id: result.razorpay_order_id,
        prefill: { contact: user?.phone || "" },
        theme: { color: "#0D9488" },
        handler: async () => {
          try {
            await simulatePaymentWebhook(result.razorpay_order_id, result.amount, true);
            onPaid(result.gift);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Payment verification failed");
            setPaying(false);
          }
        },
        modal: { ondismiss: () => setPaying(false) },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create gift");
      setPaying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" onClick={onClose}>
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Gift this item"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl bg-white p-6 shadow-elevation-3 dark:bg-neutral-900"
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-500/10">
              <GiftIcon className="h-5 w-5 text-primary-600" />
            </span>
            <h2 className="text-lg font-bold text-neutral-900 dark:text-white">Gift this item</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-xl bg-neutral-50 p-4 dark:bg-neutral-800/60">
          <p className="text-sm font-bold text-neutral-800 dark:text-neutral-100">{item.name}</p>
          {customizations.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {customizations.map((c) => `${c.name} (+${formatINR(c.price_delta)})`).join(", ")}
            </p>
          )}
          <p className="mt-2 text-lg font-extrabold text-primary-700 dark:text-primary-300">
            {formatINR(amount)}
          </p>
        </div>

        <label className="mt-4 block">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
            Recipient name (optional)
          </span>
          <input
            type="text"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            placeholder="Who is this for?"
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>

        <label className="mt-3 block">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={280}
            rows={2}
            placeholder="Say something nice..."
            className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={paying}
          onClick={handlePay}
          className="mt-5 min-h-[44px] w-full rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm disabled:opacity-50"
        >
          {paying ? "Opening payment..." : `Pay & Send (${formatINR(amount)})`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create GiftSuccess**

Create `apps/consumer/components/GiftSuccess.tsx`:

```tsx
"use client";

import { useState } from "react";
import { CheckIcon, DocumentDuplicateIcon, ShareIcon } from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import type { Gift } from "@/lib/api";
import { formatINR } from "@/lib/pricing";

export default function GiftSuccess({ gift }: { gift: Gift }) {
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/gift/${encodeURIComponent(gift.claim_token)}`
      : `/gift/${encodeURIComponent(gift.claim_token)}`;

  async function copy(text: string, which: "link" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast("Could not copy to clipboard", { duration: 3000 });
    }
  }

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${gift.item_snapshot.name} on SnakZap`,
          text: `I gifted you ${gift.item_snapshot.name} on SnakZap. Claim it here:`,
          url: link,
        });
      } else {
        await copy(link, "link");
      }
    } catch {
      // user dismissed the share sheet
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Gift sent"
        className="w-full max-w-md rounded-t-3xl bg-white p-6 text-center shadow-elevation-3 dark:bg-neutral-900"
      >
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
          <CheckIcon className="h-8 w-8 text-green-500" />
        </div>
        <h2 className="mt-4 text-xl font-bold text-neutral-900 dark:text-white">Gift sent!</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Share the link or code — your friend claims it and pays nothing.
        </p>

        <div className="mt-4 rounded-xl bg-primary-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-primary-700">Gift code</p>
          <p className="mt-1 font-mono text-2xl font-extrabold tracking-[0.3em] text-primary-700">
            {gift.claim_code}
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void share()}
            className="flex min-h-[44px] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white"
          >
            <ShareIcon className="h-5 w-5" />
            Share gift
          </button>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void copy(link, "link")}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-primary-500/30 py-2.5 text-sm font-semibold text-primary-700 dark:text-primary-400"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              {copied === "link" ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={() => void copy(gift.claim_code, "code")}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-primary-500/30 py-2.5 text-sm font-semibold text-primary-700 dark:text-primary-400"
            >
              <DocumentDuplicateIcon className="h-4 w-4" />
              {copied === "code" ? "Copied!" : "Copy code"}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs text-neutral-400">
          Valid for 90 days · {formatINR(gift.price_paid)} paid
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the gift action into the menu list**

In `apps/consumer/components/MenuItemsList.tsx`:

1. Add imports:
```tsx
import { GiftIcon } from "@heroicons/react/24/outline";
import GiftModal from "./GiftModal";
```
2. Add state + derived payload:
```tsx
  const [pickerMode, setPickerMode] = useState<"add" | "gift">("add");
  const [giftPayload, setGiftPayload] = useState<{
    item: MenuItem;
    customizations: CartCustomization[];
  } | null>(null);
```
3. Change the Add button to set the mode. Replace the existing button `onClick={() => setPickerItem(item)}` with:
```tsx
                onClick={() => {
                  setPickerMode("add");
                  setPickerItem(item);
                }}
```
4. Add a gift icon button next to the Add button (inside the same flex container):
```tsx
              <button
                type="button"
                onClick={() => {
                  setPickerMode("gift");
                  setPickerItem(item);
                }}
                aria-label={`Gift ${item.name}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500/10 text-primary-600 transition-transform active:scale-95 hover:bg-primary-500/20"
              >
                <GiftIcon className="h-5 w-5" />
              </button>
```
5. Change `CustomizationPicker onConfirm`:
```tsx
          onConfirm={(selected) => {
            if (pickerMode === "gift") {
              setGiftPayload({ item: pickerItem, customizations: selected });
              setPickerItem(null);
            } else {
              handleAdd(pickerItem, selected);
            }
          }}
```
6. Render GiftModal when `giftPayload` is set:
```tsx
      {giftPayload && (
        <GiftModal
          restaurantId={restaurantId}
          item={giftPayload.item}
          customizations={giftPayload.customizations}
          onPaid={(gift) => {
            setGiftPayload(null);
            toast.success("Gift sent!");
          }}
          onClose={() => setGiftPayload(null)}
        />
      )}
```
Note: `GiftSuccess` is shown as the final screen by rendering `<GiftSuccess gift={gift} />` inside `GiftModal` when the payment succeeds (extend `GiftModal` with a `paidGift` state: after `simulatePaymentWebhook` success, `setPaidGift(result.gift)` and render `<GiftSuccess gift={paidGift} />` instead of the form, and call `onPaid` too). Add that state to `GiftModal`:

```tsx
  const [paidGift, setPaidGift] = useState<Gift | null>(null);
```
and in the `handler` after the webhook: `setPaidGift(result.gift); onPaid(result.gift);`. At the top of the returned JSX, add:
```tsx
  if (paidGift) {
    return <GiftSuccess gift={paidGift} />;
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @snakzap/consumer exec vitest run components/__tests__/GiftModal.test.tsx components/__tests__/GiftSuccess.test.tsx components/__tests__/MenuItemsList.test.ts`
Expected: PASS (new + existing menu list tests; the added gift button should not break the existing add-to-cart tests — verify the "Add" button label stays `Add +`).

- [ ] **Step 7: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/consumer typecheck && pnpm --filter @snakzap/consumer lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/consumer/components/GiftModal.tsx apps/consumer/components/GiftSuccess.tsx apps/consumer/components/MenuItemsList.tsx apps/consumer/components/__tests__/GiftModal.test.tsx apps/consumer/components/__tests__/GiftSuccess.test.tsx
git commit -m "feat(consumer): gift modal, success screen, and menu gift action"
```

---

### Task 9: Gift landing page with claim flow + login gate

**Files:**
- Create: `apps/consumer/app/gift/[token]/page.tsx`
- Test: `apps/consumer/app/gift/__tests__/gift.test.tsx`

**Interfaces:**
- Consumes: `fetchGiftLanding`, `claimGift` (Task 7), `useAuthStore`, `useCartStore` (`addItem`), `BrandImage`, `EmptyState` from `@snakzap/ui`.
- Produces: the `/gift/[token]` claim page.

- [ ] **Step 1: Write the failing page test**

Create `apps/consumer/app/gift/__tests__/gift.test.tsx` (mock `@/lib/api`, `@/components/BrandImage`, `next/link`):

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GiftClaimPage from "../page";
import { fetchGiftLanding, claimGift } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, fetchGiftLanding: vi.fn(), claimGift: vi.fn() };
});
vi.mock("@/components/BrandImage", () => ({
  BrandImage: () => <div data-testid="brand-image" />,
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const LANDING = {
  gift: {
    id: "g1",
    claim_token: "tok1",
    claim_code: "GIFT1234",
    item_snapshot: { name: "Paneer Wrap", price: 149, image_url: null, dietary_tags: {}, spice_level: 3, customizations: [] },
    message: "Enjoy!",
    status: "ACTIVE",
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
  },
  restaurant: { name: "SnakShack", image_url: null },
  sender_display: "Ria",
  claimable: true,
};

describe("Gift claim page", () => {
  it("shows the gift card and a claim button when claimable", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true, user: { id: "u1", phone: "9999", role: "CONSUMER" } });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    expect(await screen.findByText("Paneer Wrap")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claim gift/ })).toBeTruthy();
  });

  it("disables claim and shows a reason for an expired gift", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue({
      ...LANDING,
      claimable: false,
      claim_block_reason: "This gift has expired",
      gift: { ...LANDING.gift, status: "EXPIRED" },
    } as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    expect(await screen.findByText("This gift has expired")).toBeTruthy();
    const button = screen.queryByRole("button", { name: /Claim gift/ });
    expect(button).toBeNull();
  });

  it("claims the gift and adds a free line to the cart", async () => {
    vi.mocked(fetchGiftLanding).mockResolvedValue(LANDING as never);
    vi.mocked(claimGift).mockResolvedValue({ ...LANDING.gift, status: "CLAIMED" } as never);
    useAuthStore.setState({ accessToken: "t", isAuthenticated: true, user: { id: "u1", phone: "9999", role: "CONSUMER" } });
    render(<GiftClaimPage params={Promise.resolve({ token: "tok1" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Claim gift/ }));
    await waitFor(() => expect(claimGift).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @snakzap/consumer exec vitest run app/gift/__tests__/gift.test.tsx`
Expected: FAIL — page does not exist.

- [ ] **Step 3: Create the page**

Create `apps/consumer/app/gift/[token]/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GiftIcon, ArrowRightIcon, UserIcon } from "@heroicons/react/24/outline";
import { fetchGiftLanding, claimGift, type GiftLanding } from "@/lib/api";
import { useAuthStore, useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/pricing";
import { BrandImage } from "@/components/BrandImage";
import toast from "react-hot-toast";

export default function GiftClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [landing, setLanding] = useState<GiftLanding | null>(null);
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const { accessToken, isAuthenticated } = useAuthStore();
  const addItem = useCartStore((s) => s.addItem);

  useEffect(() => {
    void params.then(({ token: t }) => setToken(t));
  }, [params]);

  const load = useCallback(async () => {
    if (!token) return;
    setError("");
    try {
      setLanding(await fetchGiftLanding(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load gift");
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  async function handleClaim() {
    if (!token) return;
    if (!isAuthenticated || !accessToken) {
      router.push(`/login?next=/gift/${encodeURIComponent(token)}`);
      return;
    }
    if (!landing) return;
    setClaiming(true);
    setError("");
    try {
      const gift = await claimGift(accessToken, token);
      addItem({
        menuItemId: gift.menu_item_id,
        name: gift.item_snapshot.name,
        basePrice: 0,
        quantity: 1,
        customizations: gift.item_snapshot.customizations,
        restaurantId: gift.restaurant_id,
        giftId: gift.id,
      });
      toast.success("Gift claimed! It is in your cart at no cost.");
      router.push(`/restaurants/${encodeURIComponent(gift.restaurant_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not claim gift");
      setClaiming(false);
    }
  }

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-elevation-2 dark:bg-neutral-900">
          <p role="alert" className="text-sm text-red-600">{error}</p>
          <Link href="/" className="btn-primary mt-5">Back to Home</Link>
        </div>
      </main>
    );
  }

  if (!landing) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
      </main>
    );
  }

  const { gift, restaurant, sender_display } = landing;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-primary-600 via-primary-500 to-primary-700 p-6">
      <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-elevation-3 dark:bg-neutral-900">
        <div className="relative h-40 bg-primary-100 dark:bg-primary-900/30">
          <BrandImage src={restaurant?.image_url} alt="" sizes="400px" className="object-cover" />
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-neutral-950/70 to-transparent" />
          <span className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur">
            <GiftIcon className="h-5 w-5" />
          </span>
          <div className="absolute bottom-3 left-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/80">A gift for you</p>
            <p className="text-lg font-extrabold">{sender_display}</p>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-extrabold text-neutral-900 dark:text-white">{gift.item_snapshot.name}</h1>
              <p className="mt-0.5 text-sm text-neutral-500">{restaurant?.name ?? "SnakZap restaurant"}</p>
            </div>
            <span className="shrink-0 rounded-full bg-green-500/10 px-3 py-1 text-xs font-bold text-green-700">
              Paid
            </span>
          </div>

          {gift.item_snapshot.spice_level > 0 && (
            <p className="mt-2 text-xs font-semibold text-neutral-500">
              Spice {gift.item_snapshot.spice_level}/5
            </p>
          )}
          {gift.item_snapshot.customizations.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              {gift.item_snapshot.customizations.map((c) => `${c.name} (+${formatINR(c.price_delta)})`).join(", ")}
            </p>
          )}
          {gift.message && (
            <blockquote className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm italic text-neutral-600 dark:bg-neutral-800">
              &ldquo;{gift.message}&rdquo;
            </blockquote>
          )}

          <p className="mt-3 text-sm text-neutral-400">
            Code: <span className="font-mono font-bold tracking-widest">{gift.claim_code}</span>
          </p>

          {landing.claimable ? (
            <button
              type="button"
              disabled={claiming}
              onClick={() => void handleClaim()}
              className="mt-5 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary-700 to-primary-500 py-3 text-sm font-bold text-white shadow-sm disabled:opacity-50"
            >
              Claim gift <ArrowRightIcon className="h-4 w-4" />
            </button>
          ) : (
            <p role="status" className="mt-5 rounded-xl bg-neutral-100 p-3 text-center text-sm text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {landing.claim_block_reason ?? "This gift is no longer available"}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">{error}</p>
          )}

          <div className="mt-4 flex items-center justify-center gap-1 text-xs text-neutral-400">
            <UserIcon className="h-3.5 w-3.5" />
            Claim with your phone number — pays nothing
          </div>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @snakzap/consumer exec vitest run app/gift/__tests__/gift.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `cd /workspace && pnpm --filter @snakzap/consumer typecheck && pnpm --filter @snakzap/consumer lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/consumer/app/gift/[token]/page.tsx apps/consumer/app/gift/__tests__/gift.test.tsx
git commit -m "feat(consumer): gift landing and claim page with login gate"
```

---

### Task 10: Profile My Gifts + cart gift display + checkout gift passthrough

**Files:**
- Modify: `apps/consumer/app/profile/page.tsx`
- Modify: `apps/consumer/components/CartDrawer.tsx`
- Modify: `apps/consumer/app/checkout/page.tsx`
- Test: `apps/consumer/components/__tests__/CartDrawer.gift.test.tsx`

**Interfaces:**
- Consumes: `fetchMyGifts`, `cancelGift`, `retryGiftPayment`, `releaseGift` (Task 7), `CartItem.giftId`.
- Produces: My Gifts section in profile; cart gift badge + remove→release; checkout sends `gift_id` on order lines.

- [ ] **Step 1: Write the failing cart test**

Create `apps/consumer/components/__tests__/CartDrawer.gift.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CartDrawer } from "../CartDrawer";
import { useCartStore, useAuthStore } from "@/lib/store";
import { releaseGift } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, createGroupCart: vi.fn(), releaseGift: vi.fn() };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@snakzap/ui", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock("../BrandImage", () => ({ BrandImage: () => <div data-testid="brand-image" /> }));

beforeEach(() => {
  useAuthStore.setState({ accessToken: "t", isAuthenticated: true });
  useCartStore.setState({
    items: [
      {
        menuItemId: "m1",
        name: "Paneer Wrap",
        basePrice: 0,
        quantity: 1,
        customizations: [],
        restaurantId: "r1",
        giftId: "g1",
      },
      {
        menuItemId: "m2",
        name: "Cold Coffee",
        basePrice: 120,
        quantity: 1,
        customizations: [],
        restaurantId: "r1",
      },
    ],
    restaurantId: "r1",
    restaurantName: "SnakShack",
  });
});

describe("CartDrawer gift lines", () => {
  it("shows a gift badge and a ₹0 price", () => {
    render(<CartDrawer open onClose={() => {}} />);
    expect(screen.getAllByText("Gift").length).toBeGreaterThan(0);
    expect(screen.getByText("₹0 each")).toBeTruthy();
  });

  it("calls releaseGift when removing a gift line", async () => {
    vi.mocked(releaseGift).mockResolvedValue({ id: "g1", status: "ACTIVE" } as never);
    render(<CartDrawer open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Paneer Wrap" }));
    await vi.waitFor(() => expect(releaseGift).toHaveBeenCalledWith("t", "g1"));
  });
});
```

Note: `CartItem.giftId` is carried on the persisted cart; the claim flow stores the raw `claim_token` client-side so `releaseGift` can be called with the token. Simplest consistent choice: `CartItem.giftToken` holds `gift.claim_token` (the claim endpoint returns the gift with its `claim_token`). Add `giftToken?: string` to `CartItem` in `lib/store.ts` (same treatment as `giftId`: pass through persist/hydrate as `gift_token`) and set it during claim in Task 9 (`giftToken: gift.claim_token`). `removeItem` in the store fires `releaseGift(accessToken, item.giftToken)` best-effort.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @snakzap/consumer exec vitest run components/__tests__/CartDrawer.gift.test.tsx`
Expected: FAIL — no gift badge / release call.

- [ ] **Step 3: Extend the cart store for release-on-remove**

In `apps/consumer/lib/store.ts`:
1. Add to `CartItem`: `giftToken?: string;` (and keep `giftId?: string;`).
2. `persistCurrent` maps `gift_token: i.giftToken` (add to the mapped object).
3. `hydrateFromServer` maps `giftToken: (i as { gift_token?: string | null }).gift_token ?? undefined`.
4. Add `releaseGift` import from `./api` and fire on remove:
```ts
  removeItem: (menuItemId) => {
    const current = get();
    const removed = current.items.find((i) => i.menuItemId === menuItemId);
    const next = current.items.filter((i) => i.menuItemId !== menuItemId);
    set({
      items: next,
      restaurantId: next.length > 0 ? current.restaurantId : null,
      restaurantName: next.length > 0 ? current.restaurantName : null,
    });
    persistCurrent();
    const token = useAuthStore.getState().accessToken;
    if (token && removed?.giftToken) {
      void releaseGift(token, removed.giftToken).catch(() => {
        // best-effort: the server sweep reclaims expired claims
      });
    }
  },
```
5. In `apps/consumer/lib/api.ts`, extend `PersistedCartItem` with `gift_token?: string | null;` and `gift_id?: string | null;` (already added in Task 7 — just ensure both).

- [ ] **Step 4: Show the gift badge + remove in CartDrawer**

In `apps/consumer/components/CartDrawer.tsx`:

1. Import `GiftIcon`:
```tsx
import { GiftIcon, XMarkIcon, ShoppingBagIcon } from "@heroicons/react/24/outline";
```
2. Inside the item card, under the item name, when `item.giftId`:
```tsx
                  {item.giftId && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary-500/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-primary-700">
                      <GiftIcon className="h-3 w-3" />
                      Gift
                    </span>
                  )}
```
3. Lock quantity controls for gift lines — wrap the `+`/`-`/count block so it only renders when `!item.giftId`:
```tsx
                {!item.giftId && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" aria-label="Decrease quantity" onClick={() => updateQuantity(item.menuItemId, item.quantity - 1)} className="...">-</button>
                    <span className="w-6 text-center text-sm font-bold ...">{item.quantity}</span>
                    <button type="button" aria-label="Increase quantity" onClick={() => updateQuantity(item.menuItemId, item.quantity + 1)} className="...">+</button>
                  </div>
                )}
```
4. Keep the `Remove` button as-is (it now triggers release via the store).

- [ ] **Step 5: Pass gift_id through checkout**

In `apps/consumer/app/checkout/page.tsx`, in `handlePlaceOrder`, change the items mapping:
```ts
          items: items.map((item) => ({
            menu_item_id: item.menuItemId,
            quantity: item.quantity,
            customizations: item.customizations,
            ...(item.giftId ? { gift_id: item.giftId } : {}),
          })),
```

- [ ] **Step 6: Add My Gifts to the profile page**

In `apps/consumer/app/profile/page.tsx`:

1. Add imports:
```tsx
import { fetchMyGifts, cancelGift, retryGiftPayment, type Gift } from "@/lib/api";
```
2. In `ProfileContent`, add state + loader:
```tsx
  const [gifts, setGifts] = useState<Gift[] | null>(null);
```
and in the `useEffect` loader block add:
```ts
    void load("gifts", () => fetchMyGifts(accessToken), setGifts);
```
(define `load` the same way the existing block does; add `"gifts"` to the cache-busting object if any.)
3. Render a `GiftsSection` above the Wallet section when `gifts && gifts.length > 0`:

```tsx
function GiftsSection({ gifts, onUpdated }: { gifts: Gift[]; onUpdated: () => void }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [busy, setBusy] = useState<string | null>(null);

  async function handleCancel(id: string) {
    if (!accessToken) return;
    setBusy(id);
    try {
      await cancelGift(accessToken, id);
      onUpdated();
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(id: string) {
    if (!accessToken) return;
    setBusy(id);
    try {
      await retryGiftPayment(accessToken, id);
      onUpdated();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <h2 className="mb-3 text-lg font-semibold text-neutral-700 dark:text-neutral-100">My Gifts</h2>
      <ul className="space-y-3">
        {gifts.map((gift) => (
          <li key={gift.id} className="flex items-center justify-between gap-3 rounded-xl border border-neutral-100 p-3 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-neutral-800 dark:text-neutral-100">
                {gift.item_snapshot.name}
              </p>
              <p className="text-xs text-neutral-400">
                {formatINR(gift.price_paid)} · {gift.status}
                {gift.recipient_name ? ` · for ${gift.recipient_name}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {gift.status === "PENDING" && (
                <button type="button" onClick={() => void handleRetry(gift.id)} disabled={busy === gift.id} className="btn-outline rounded-full px-3 py-1 text-xs font-semibold">
                  Retry payment
                </button>
              )}
              {(gift.status === "ACTIVE" || gift.status === "PENDING") && (
                <button type="button" onClick={() => void handleCancel(gift.id)} disabled={busy === gift.id} className="rounded-full border border-red-500/30 px-3 py-1 text-xs font-semibold text-red-600">
                  Cancel
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
4. Render it inside `ProfileContent` with the existing section spacing, and wire `onUpdated={() => void load("gifts", () => fetchMyGifts(accessToken), setGifts)}`. Ensure `formatINR` is imported in profile (`import { formatINR } from "@/lib/pricing";`).

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @snakzap/consumer exec vitest run components/__tests__/CartDrawer.gift.test.tsx app/profile/__tests__/status.test.tsx app/checkout/__tests__/checkout.test.tsx`
Expected: PASS (new + existing profile/checkout tests; adjust selectors if existing tests relied on the item row layout).

- [ ] **Step 8: Typecheck + lint + full consumer suite**

Run: `cd /workspace && pnpm --filter @snakzap/consumer typecheck && pnpm --filter @snakzap/consumer lint && pnpm --filter @snakzap/consumer test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/consumer/lib/store.ts apps/consumer/lib/api.ts apps/consumer/components/CartDrawer.tsx apps/consumer/app/checkout/page.tsx apps/consumer/app/profile/page.tsx apps/consumer/components/__tests__/CartDrawer.gift.test.tsx
git commit -m "feat(consumer): profile my gifts, cart gift display, and checkout gift passthrough"
```

---

## Final Verification

After all tasks are complete, run from the repo root:

```bash
pnpm exec vitest run
pnpm --filter @snakzap/api typecheck
pnpm --filter @snakzap/api lint
pnpm --filter @snakzap/consumer test
pnpm --filter @snakzap/consumer typecheck
pnpm --filter @snakzap/consumer lint
```

Expected: all suites pass. Then run a full whole-branch review (review-package over all task commits) before opening the PR.

## Self-Review Notes (verify before dispatch)

- The `paymentRepo.getByGiftId` and `giftRepo` constructor args flow: `PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo)`.
- `OrderingService(sharedOrderRepo, getCatalogRepository(), sharedGiftRepo)` in both `orders.ts` and `wear.ts`.
- `FulfillmentService(sharedOrderRepo, sharedGiftRepo)` in `fulfillment.ts`.
- Gift landing viewer auth: the public `GET /t/:token` route does NOT use `authenticate`, so `res.locals.userId` is absent — keep `viewerId` null (or wire optional auth later). Self-gift detection therefore only happens at claim time (`claim` endpoint enforces it).
- `listDueForExpiry` includes `REFUNDING` so failed refund submissions are retried; it excludes `FULFILLED/REFUNDED/CANCELLED`.
- `simulatePaymentWebhook` (existing consumer util) POSTs a `payment.captured` payload to the shared webhook — the webhook routes by `payment.gift_id` for gifts, so the demo checkout flow works unchanged for gift purchases.
