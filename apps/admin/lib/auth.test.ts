import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  getAccessToken,
  getUserRole,
  isAdmin,
  logout,
  storeSession,
} from "./auth";

function createLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
}

function adminToken(role: string): string {
  const payload = btoa(JSON.stringify({ sub: "u1", role, exp: 9999999999 }));
  return `header.${payload}.signature`;
}

describe("admin auth lib", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", createLocalStorageStub());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("storeSession persists the token and derived role", () => {
    storeSession(adminToken("ADMIN"));
    expect(getAccessToken()).toBeTruthy();
    expect(getUserRole()).toBe("ADMIN");
    expect(isAdmin()).toBe(true);
  });

  it("isAdmin is false for non-admin roles and unknown tokens", () => {
    storeSession(adminToken("CONSUMER"));
    expect(isAdmin()).toBe(false);
  });

  it("clearSession drops both local keys", () => {
    storeSession(adminToken("SUPER_ADMIN"));
    clearSession();
    expect(getAccessToken()).toBeNull();
    expect(getUserRole()).toBeNull();
    expect(isAdmin()).toBe(false);
  });

  it("logout calls the server endpoint with credentials and clears the session", async () => {
    storeSession(adminToken("ADMIN"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { logged_out: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(getAccessToken()).toBeNull();
    expect(getUserRole()).toBeNull();
  });

  it("logout still clears the local session when the server call fails", async () => {
    storeSession(adminToken("ADMIN"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(logout()).resolves.toBeUndefined();

    expect(getAccessToken()).toBeNull();
    expect(getUserRole()).toBeNull();
    expect(isAdmin()).toBe(false);
  });
});
