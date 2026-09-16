import { describe, expect, it, beforeEach } from "vitest";
import { MemoryGiftRepository } from "./giftRepository";
import type { CreateGiftInput, GiftDTO, GiftStatus } from "./giftRepository";

const RECIPIENT = "44444444-4444-4444-8444-444444444444";

async function seed(repo: MemoryGiftRepository, expiresInDays = 90): Promise<GiftDTO> {
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
    expires_at: new Date(Date.now() + expiresInDays * 24 * 3600_000).toISOString(),
  };
  return repo.create(input);
}

/** Drives a freshly-seeded gift to `status` through real guarded transitions. */
async function advance(repo: MemoryGiftRepository, id: string, status: GiftStatus): Promise<GiftDTO> {
  const farFuture = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
  const needPaid = status !== "PENDING" && status !== "CANCELLED";
  if (needPaid) await repo.markPaid(id);
  switch (status) {
    case "PENDING":
    case "ACTIVE":
      return (await repo.getById(id))!;
    case "CANCELLED":
      return (await repo.cancelPending(id))!;
    case "CLAIMED":
      return (await repo.markClaimed(id, RECIPIENT))!;
    case "FULFILLED": {
      await repo.markClaimed(id, RECIPIENT);
      await repo.bindToOrder(id, "order-1");
      return (await repo.markFulfilled(id, "order-1"))!;
    }
    case "EXPIRED":
      return (await repo.expireIfDueAndUnbound(id, farFuture))!;
    case "REFUNDING":
      return (await repo.markRefundSubmitted(id, ["ACTIVE"]))!;
    case "REFUNDED": {
      await repo.markRefundSubmitted(id, ["ACTIVE"]);
      return (await repo.markRefunded(id))!;
    }
    default:
      throw new Error(`advance: unsupported status ${status}`);
  }
}

describe("MemoryGiftRepository", () => {
  let repo: MemoryGiftRepository;

  beforeEach(() => {
    repo = new MemoryGiftRepository();
  });

  it("creates a PENDING gift and returns a GiftDTO", async () => {
    const gift = await seed(repo);
    expect(gift.id).toBeTruthy();
    expect(gift.status).toBe("PENDING");
    expect(gift.price_paid).toBe(179);
    expect(gift.item_snapshot.name).toBe("Paneer Wrap");
  });

  it("finds a gift by claim token", async () => {
    const gift = await seed(repo);
    const found = await repo.getByToken("tok-abc");
    expect(found?.id).toBe(gift.id);
  });

  it("marks a gift claimed and clears it on release", async () => {
    const gift = await seed(repo);
    await repo.markPaid(gift.id);
    const claimed = await repo.markClaimed(gift.id, RECIPIENT);
    expect(claimed?.status).toBe("CLAIMED");
    expect(claimed?.claimed_by).toBe(RECIPIENT);
    const released = await repo.release(gift.id);
    expect(released?.status).toBe("ACTIVE");
    expect(released?.claimed_by).toBeNull();
  });

  it("lists gifts due for expiry", async () => {
    const gift = await seed(repo);
    await repo.markPaid(gift.id);
    const due = await repo.listDueForExpiry(
      new Date(Date.now() + 91 * 24 * 3600_000).toISOString(),
    );
    expect(due.map((g) => g.id)).toContain(gift.id);
  });

  describe("CAS transitions", () => {
    it("claims exactly once: a second markClaimed loses", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      const winner = await repo.markClaimed(gift.id, "u1");
      const loser = await repo.markClaimed(gift.id, "u2");
      expect(winner?.status).toBe("CLAIMED");
      expect(loser).toBeNull();
      expect((await repo.getById(gift.id))?.claimed_by).toBe("u1");
    });

    it("binds a claimed gift to exactly one order (second bindToOrder loses)", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      const first = await repo.bindToOrder(gift.id, "order-1");
      const second = await repo.bindToOrder(gift.id, "order-2");
      expect(first?.redeemed_order_id).toBe("order-1");
      expect(second).toBeNull();
    });

    it("refuses to release a gift already bound to an order", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      expect(await repo.release(gift.id)).toBeNull();
    });

    it("fulfills only the order the gift is bound to, and only once", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      const fulfilled = await repo.markFulfilled(gift.id, "order-1");
      const wrongOrder = await repo.markFulfilled(gift.id, "order-2");
      const again = await repo.markFulfilled(gift.id, "order-1");
      expect(fulfilled?.status).toBe("FULFILLED");
      expect(wrongOrder).toBeNull();
      expect(again).toBeNull();
    });

    it("never regresses a FULFILLED gift to REFUNDED", async () => {
      const gift = await seed(repo);
      await advance(repo, gift.id, "FULFILLED");
      expect(await repo.markRefunded(gift.id)).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("FULFILLED");
    });

    it("marks the refund submission exactly once", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      const first = await repo.markRefundSubmitted(gift.id, ["ACTIVE"]);
      const second = await repo.markRefundSubmitted(gift.id, ["ACTIVE"]);
      expect(first?.status).toBe("REFUNDING");
      expect(first?.refund_requested_at).not.toBeNull();
      expect(second).toBeNull();
      // A cleared marker allows a retry.
      await repo.clearRefundSubmitted(gift.id);
      expect((await repo.getById(gift.id))?.refund_requested_at).toBeNull();
    });

    it("refuses to start a refund for a FULFILLED gift (no status regression)", async () => {
      const gift = await seed(repo);
      await advance(repo, gift.id, "FULFILLED");
      expect(await repo.markRefundSubmitted(gift.id, ["ACTIVE"])).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("FULFILLED");
    });

    it("only pays a PENDING gift into ACTIVE", async () => {
      const cancelled = await seed(repo);
      await repo.cancelPending(cancelled.id);
      expect(await repo.markPaid(cancelled.id)).toBeNull();

      const pending = await seed(repo);
      expect((await repo.markPaid(pending.id))?.status).toBe("ACTIVE");
    });
  });

  // ============================================================
  // P1 — memory cancel CAS semantics
  // ============================================================
  describe("cancelPending CAS", () => {
    it("T1: cancels a PENDING gift", async () => {
      const gift = await seed(repo);
      const cancelled = await repo.cancelPending(gift.id);
      expect(cancelled?.status).toBe("CANCELLED");
    });

    it("T2: a stale cancel cannot overwrite ACTIVE", async () => {
      const gift = await seed(repo);
      // Payment capture wins the race first.
      expect((await repo.markPaid(gift.id))?.status).toBe("ACTIVE");
      expect(await repo.cancelPending(gift.id)).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("ACTIVE");
    });
  });

  // ============================================================
  // P2 — memory expiry CAS semantics
  // ============================================================
  describe("expireIfDueAndUnbound CAS", () => {
    const futureIso = (): string => new Date(Date.now() + 400 * 24 * 3600_000).toISOString();

    it("T5: expires a due unbound ACTIVE gift", async () => {
      const gift = await seed(repo, 1);
      await repo.markPaid(gift.id);
      const expired = await repo.expireIfDueAndUnbound(gift.id, futureIso());
      expect(expired?.status).toBe("EXPIRED");
    });

    it("T6: expires a due unbound CLAIMED gift", async () => {
      const gift = await seed(repo, 1);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      const expired = await repo.expireIfDueAndUnbound(gift.id, futureIso());
      expect(expired?.status).toBe("EXPIRED");
    });

    it("T7: a bound gift cannot become EXPIRED", async () => {
      const gift = await seed(repo, 1);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      expect(await repo.expireIfDueAndUnbound(gift.id, futureIso())).toBeNull();
      const after = await repo.getById(gift.id);
      expect(after?.status).toBe("CLAIMED");
      expect(after?.redeemed_order_id).toBe("order-1");
    });

    it("does not expire a gift that is not yet due", async () => {
      const gift = await seed(repo, 30);
      await repo.markPaid(gift.id);
      expect(await repo.expireIfDueAndUnbound(gift.id, new Date().toISOString())).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("ACTIVE");
    });
  });

  // ============================================================
  // P3 — memory refund state guard
  // ============================================================
  describe("refund transition guards", () => {
    it("T11: confirms a refund from REFUNDING", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      await repo.markRefundSubmitted(gift.id, ["ACTIVE"]);
      const refunded = await repo.markRefunded(gift.id);
      expect(refunded?.status).toBe("REFUNDED");
    });

    it("T12: confirms a refund from EXPIRED", async () => {
      const gift = await seed(repo, 1);
      await repo.markPaid(gift.id);
      await repo.expireIfDueAndUnbound(gift.id, new Date(Date.now() + 400 * 24 * 3600_000).toISOString());
      const refunded = await repo.markRefunded(gift.id);
      expect(refunded?.status).toBe("REFUNDED");
    });

    it("T13: a stale confirmation from ACTIVE is a no-op", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      expect(await repo.markRefunded(gift.id)).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("ACTIVE");
    });

    it("GIFT-3: a CLAIMED gift is not an allowed refund-submission source", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      await repo.markClaimed(gift.id, "u1");
      expect(await repo.markRefundSubmitted(gift.id, ["ACTIVE"])).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("CLAIMED");
    });

    it("markRefunding only moves an expected-state gift to REFUNDING", async () => {
      const gift = await seed(repo);
      await repo.markPaid(gift.id);
      expect(await repo.markRefunding(gift.id, ["EXPIRED"])).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("ACTIVE");
      expect((await repo.markRefunding(gift.id, ["ACTIVE"]))?.status).toBe("REFUNDING");
    });
  });

  // ============================================================
  // T14 — terminal preservation
  // ============================================================
  describe("terminal preservation", () => {
    it("T14: FULFILLED/CANCELLED/REFUNDED cannot be regressed by covered CAS", async () => {
      const fulfilled = await seed(repo);
      await advance(repo, fulfilled.id, "FULFILLED");
      expect(await repo.cancelPending(fulfilled.id)).toBeNull();
      expect(await repo.markPaid(fulfilled.id)).toBeNull();
      expect(await repo.markRefunded(fulfilled.id)).toBeNull();
      expect(await repo.expireIfDueAndUnbound(fulfilled.id, new Date(Date.now() + 400 * 24 * 3600_000).toISOString())).toBeNull();
      expect((await repo.getById(fulfilled.id))?.status).toBe("FULFILLED");

      const cancelled = await seed(repo);
      await advance(repo, cancelled.id, "CANCELLED");
      expect(await repo.markPaid(cancelled.id)).toBeNull();
      expect(await repo.markRefundSubmitted(cancelled.id, ["ACTIVE"])).toBeNull();
      expect((await repo.getById(cancelled.id))?.status).toBe("CANCELLED");

      const refunded = await seed(repo);
      await advance(repo, refunded.id, "REFUNDED");
      expect(await repo.cancelPending(refunded.id)).toBeNull();
      expect(await repo.markRefundSubmitted(refunded.id, ["REFUNDING"])).toBeNull();
      expect((await repo.getById(refunded.id))?.status).toBe("REFUNDED");
    });
  });
});
