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
