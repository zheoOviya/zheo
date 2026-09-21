import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyReferral,
  fetchReferralProfile,
  fetchRestaurants,
  fetchWallet,
  invalidateLoyaltyCachesAfterOrder,
  type ReferralProfile,
  type WalletData,
} from "./api";
import { clearCache } from "./cache";

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data, error: null }),
  };
}

interface MockResponseOptions {
  ok?: boolean;
  status?: number;
  body?: unknown;
  parseError?: Error;
}

function mockResponse({
  ok = true,
  status = 200,
  body = null,
  parseError,
}: MockResponseOptions = {}) {
  return {
    ok,
    status,
    json: () => (parseError ? Promise.reject(parseError) : Promise.resolve(body)),
  };
}

function errorEnvelope(code: string, message: string) {
  return { success: false, data: null, error: { code, message } };
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

describe("fetcher response hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns data for a valid 200 envelope", async () => {
    const restaurants = [{ id: "r1" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(restaurants)));

    await expect(fetchRestaurants()).resolves.toEqual(restaurants);
  });

  it("rejects a 500 JSON error envelope with a readable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, body: errorEnvelope("SERVER", "Boom") }),
      ),
    );

    await expect(fetchRestaurants()).rejects.toThrow("Boom");
  });

  it("rejects a 500 whose envelope claims success:true (status wins)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, body: { success: true, data: [], error: null } }),
      ),
    );

    await expect(fetchRestaurants()).rejects.toThrow("Request failed");
  });

  it("normalizes an HTML/non-JSON error body to an Error, not a SyntaxError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 502,
          parseError: new SyntaxError("Unexpected token < in JSON at position 0"),
        }),
      ),
    );

    const err = await fetchRestaurants().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).toBe("Request failed");
  });

  it("rejects malformed JSON on a 200 without leaking SyntaxError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 200, parseError: new SyntaxError("bad") })),
    );

    const err = await fetchRestaurants().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it("rejects a 200 with a wrong or missing envelope", async () => {
    for (const body of [{}, { foo: "bar" }, { success: true }, ["x"], null]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ body })));
      await expect(fetchRestaurants()).rejects.toThrow("Request failed");
    }
  });

  it("rejects a 204 / empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 204, parseError: new SyntaxError("empty") })),
    );

    await expect(fetchRestaurants()).rejects.toThrow("Request failed");
  });

  it("preserves a network rejection as an Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(fetchRestaurants()).rejects.toThrow("network down");
  });
});

describe("authedFetcher response hardening", () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearCache();
  });

  it("returns data for a valid 200 envelope", async () => {
    const wallet: WalletData = { user_id: "u1", balance: 1, total_earned: 2, transactions: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(wallet)));

    await expect(fetchWallet("tok-valid")).resolves.toEqual(wallet);
  });

  it("rejects a 401 error envelope and preserves the error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 401, body: errorEnvelope("UNAUTHORIZED", "No session") }),
      ),
    );

    const err = await fetchWallet("tok-401").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("No session");
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("rejects a 500 whose envelope claims success:true (status wins)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, body: { success: true, data: {}, error: null } }),
      ),
    );

    await expect(fetchWallet("tok-500-true")).rejects.toThrow("Request failed");
  });

  it("normalizes a non-JSON error body to an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, parseError: new SyntaxError("html") }),
      ),
    );

    const err = await fetchWallet("tok-nonjson").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it("rejects malformed JSON on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 200, parseError: new SyntaxError("bad") })),
    );

    await expect(fetchWallet("tok-malformed")).rejects.toThrow("Request failed");
  });

  it("rejects a 204 / empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 204, parseError: new SyntaxError("empty") })),
    );

    await expect(fetchWallet("tok-empty")).rejects.toThrow("Request failed");
  });
});
