import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyReferral,
  fetchReferralProfile,
  fetchWallet,
  invalidateLoyaltyCachesAfterOrder,
  type ReferralProfile,
  type WalletData,
} from "./api";
import { clearCache } from "./cache";

function jsonResponse(data: unknown) {
  return { json: () => Promise.resolve({ success: true, data, error: null }) };
}

describe("api client caching", () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCache();
  });

  it("reuses wallet data within the TTL", async () => {
    const wallet: WalletData = {
      user_id: "u1",
      balance: 42,
      total_earned: 50,
      transactions: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(wallet));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchWallet("tok");
    const second = await fetchWallet("tok");

    expect(first).toEqual(wallet);
    expect(second).toEqual(wallet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates referral and wallet caches after applying a referral", async () => {
    const profile: ReferralProfile = {
      referral_code: "SNKZ-1",
      bonus_amount: 50,
      balance: 0,
      total_earned: 0,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse({ applied: true }))
      .mockResolvedValueOnce(jsonResponse({ ...profile, balance: 50 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchReferralProfile("tok");
    await applyReferral("tok", "SNKZ-1");
    const after = await fetchReferralProfile("tok");

    expect(after.balance).toBe(50);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-fetches loyalty data after an order is placed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWallet("tok");
    await fetchWallet("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateLoyaltyCachesAfterOrder();

    await fetchWallet("tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
