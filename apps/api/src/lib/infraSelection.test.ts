import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================
// Real-infra test-mode selection (Task 6B).
//
// Proves the TEST_REAL_INFRA=true opt-in contract WITHOUT a live Postgres
// or Redis: the pg Pool / ioredis clients are constructed lazily, so these
// assertions validate *selection* (which backend gets wired) and the
// fail-loud behavior for missing config — not connectivity.
//
// Every scenario re-imports the modules fresh (vi.resetModules) so the
// process.env snapshot at import time drives config + backend selection.
// ============================================

async function loadInfra() {
  vi.resetModules();
  const redis = await import("./redis");
  const db = await import("./db");
  const shared = await import("../repositories/shared");
  return { redis, db, shared };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("TEST_REAL_INFRA selection", () => {
  it("RED 1/3: default NODE_ENV=test uses MemoryRedis even with REDIS_URL set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const { redis } = await loadInfra();
    expect(redis.getRedis()).toBeInstanceOf(redis.MemoryRedis);
  });

  it("RED 2/3: default NODE_ENV=test keeps PostgreSQL unavailable", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { db } = await loadInfra();
    expect(() => db.createDb()).toThrow(/not available in test mode/);
  });

  it("RED 3/3: default NODE_ENV=test selects memory repositories", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { shared } = await loadInfra();
    expect(shared.getStorageMode()).toBe("memory");
  });

  it("GREEN 1/4: TEST_REAL_INFRA=true selects real Redis (not MemoryRedis)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const { redis } = await loadInfra();
    const client = redis.getRedis();
    expect(client).not.toBeInstanceOf(redis.MemoryRedis);
  });

  it("GREEN 2/4: TEST_REAL_INFRA=true permits PostgreSQL through createDb()", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://snakzap:snakzap_test_pw@127.0.0.1:5432/snakzap_test");
    const { db } = await loadInfra();
    expect(() => db.createDb()).not.toThrow();
  });

  it("GREEN 3/4: TEST_REAL_INFRA=true selects postgres repositories (no memory fallback)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://snakzap:snakzap_test_pw@127.0.0.1:5432/snakzap_test");
    const { shared } = await loadInfra();
    expect(shared.getStorageMode()).toBe("postgres");
  });

  it("GREEN 4/4: TEST_REAL_INFRA=true never falls back to memory on broken DB", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://no-such-host.invalid:5432/nope");
    const { shared } = await loadInfra();
    expect(shared.getStorageMode()).toBe("postgres");
  });

  it("FAIL-LOUD 1/4: TEST_REAL_INFRA=true with empty DATABASE_URL throws (no fallback)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("DATABASE_URL", "");
    const { db } = await loadInfra();
    expect(() => db.createDb()).toThrow(/TEST_REAL_INFRA requires DATABASE_URL/);
  });

  it("FAIL-LOUD 2/4: TEST_REAL_INFRA=true with UNSET DATABASE_URL throws (config default does not satisfy)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("DATABASE_URL", undefined);
    const { db } = await loadInfra();
    expect(() => db.createDb()).toThrow(/TEST_REAL_INFRA requires DATABASE_URL/);
  });

  it("FAIL-LOUD 3/4: TEST_REAL_INFRA=true with empty REDIS_URL throws (no memory)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("REDIS_URL", "");
    const { redis } = await loadInfra();
    expect(() => redis.getRedis()).toThrow(/TEST_REAL_INFRA requires REDIS_URL/);
  });

  it("FAIL-LOUD 4/4: TEST_REAL_INFRA=true with UNSET REDIS_URL throws (config default does not satisfy)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_REAL_INFRA", "true");
    vi.stubEnv("REDIS_URL", undefined);
    const { redis } = await loadInfra();
    expect(() => redis.getRedis()).toThrow(/TEST_REAL_INFRA requires REDIS_URL/);
  });
});
