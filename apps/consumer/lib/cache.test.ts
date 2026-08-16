import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cached, clearCache, getCached, invalidateByPrefix, setCached } from "./cache";

describe("client cache", () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCache();
  });

  it("returns null when no entry exists", () => {
    expect(getCached("missing")).toBeNull();
  });

  it("stores and retrieves within the TTL", () => {
    setCached("wallet:tok", { balance: 10 });
    expect(getCached("wallet:tok")).toEqual({ balance: 10 });
  });

  it("reuses cached data within the TTL", async () => {
    const load = vi.fn().mockResolvedValue({ balance: 42 });

    const first = await cached("wallet:tok", load);
    const second = await cached("wallet:tok", load);

    expect(first).toEqual({ balance: 42 });
    expect(second).toEqual({ balance: 42 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("falls back to the network after the TTL expires", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue({ balance: 1 });

    await cached("wallet:tok", load, 60_000);
    await cached("wallet:tok", load, 60_000);
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await cached("wallet:tok", load, 60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidates only entries matching the prefix", () => {
    setCached("wallet:tok1", "a");
    setCached("streak:tok1", "b");
    setCached("wallet:tok2", "c");

    invalidateByPrefix("wallet:");

    expect(getCached("wallet:tok1")).toBeNull();
    expect(getCached("wallet:tok2")).toBeNull();
    expect(getCached("streak:tok1")).toBe("b");
  });

  it("re-fetches after invalidation", async () => {
    const load = vi.fn().mockResolvedValue({ balance: 99 });

    await cached("wallet:tok", load);
    invalidateByPrefix("wallet:");
    await cached("wallet:tok", load);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
