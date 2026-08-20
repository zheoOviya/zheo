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
});
