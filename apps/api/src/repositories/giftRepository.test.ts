import { describe, expect, it, beforeEach } from "vitest";
import { MemoryGiftRepository } from "./giftRepository";
import type { CreateGiftInput, GiftDTO } from "./giftRepository";

async function seed(repo: MemoryGiftRepository): Promise<GiftDTO> {
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
    const claimed = await repo.markClaimed(gift.id, "44444444-4444-4444-8444-444444444444");
    expect(claimed?.status).toBe("CLAIMED");
    expect(claimed?.claimed_by).toBe("44444444-4444-4444-8444-444444444444");
    const released = await repo.release(gift.id);
    expect(released?.status).toBe("ACTIVE");
    expect(released?.claimed_by).toBeNull();
  });

  it("lists gifts due for expiry", async () => {
    const gift = await seed(repo);
    await repo.updateStatus(gift.id, "ACTIVE");
    const due = await repo.listDueForExpiry(
      new Date(Date.now() + 91 * 24 * 3600_000).toISOString(),
    );
    expect(due.map((g) => g.id)).toContain(gift.id);
  });

  describe("CAS transitions", () => {
    it("claims exactly once under concurrency (second markClaimed loses)", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
      const winner = await repo.markClaimed(gift.id, "u1");
      const loser = await repo.markClaimed(gift.id, "u2");
      expect(winner?.status).toBe("CLAIMED");
      expect(loser).toBeNull();
      expect((await repo.getById(gift.id))?.claimed_by).toBe("u1");
    });

    it("binds a claimed gift to exactly one order (second bindToOrder loses)", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
      await repo.markClaimed(gift.id, "u1");
      const first = await repo.bindToOrder(gift.id, "order-1");
      const second = await repo.bindToOrder(gift.id, "order-2");
      expect(first?.redeemed_order_id).toBe("order-1");
      expect(second).toBeNull();
    });

    it("refuses to release a gift already bound to an order", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      expect(await repo.release(gift.id)).toBeNull();
    });

    it("fulfills only the order the gift is bound to, and only once", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
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
      await repo.updateStatus(gift.id, "ACTIVE");
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      await repo.markFulfilled(gift.id, "order-1");
      expect(await repo.markRefunded(gift.id)).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("FULFILLED");
    });

    it("marks the refund submission exactly once", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
      const first = await repo.markRefundSubmitted(gift.id);
      const second = await repo.markRefundSubmitted(gift.id);
      expect(first?.status).toBe("REFUNDING");
      expect(first?.refund_requested_at).not.toBeNull();
      expect(second).toBeNull();
      // A cleared marker allows a retry.
      await repo.clearRefundSubmitted(gift.id);
      expect((await repo.getById(gift.id))?.refund_requested_at).toBeNull();
    });

    it("refuses to start a refund for a FULFILLED gift (no status regression)", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "ACTIVE");
      await repo.markClaimed(gift.id, "u1");
      await repo.bindToOrder(gift.id, "order-1");
      await repo.markFulfilled(gift.id, "order-1");
      expect(await repo.markRefundSubmitted(gift.id)).toBeNull();
      expect((await repo.getById(gift.id))?.status).toBe("FULFILLED");
    });

    it("only pays a PENDING gift into ACTIVE", async () => {
      const gift = await seed(repo);
      await repo.updateStatus(gift.id, "CANCELLED");
      expect(await repo.markPaid(gift.id)).toBeNull();
      await repo.updateStatus(gift.id, "PENDING");
      expect((await repo.markPaid(gift.id))?.status).toBe("ACTIVE");
    });
  });
});
