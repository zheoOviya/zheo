import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  getAccessToken,
  getSessionUser,
  hydrateSession,
  logout,
  refreshSession,
  storeSession,
} from "@/lib/auth";
import { authedFetch } from "@/lib/api";

// ============================================
// Integration coverage for the vendor auth flow:
// token refresh (401 -> /refresh -> retry), silent
// rotation, session hydration, and logout. The real
// auth/api modules are exercised end to end; only the
// global fetch is mocked (httpOnly cookies mean no
// Authorization header is sent from JS).
// ============================================

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  clearSession();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  try {
    // jsdom cannot navigate; silence the redirect in the 401-failure path.
    Object.defineProperty(window, "location", {
      value: { href: "", assign: vi.fn(), replace: vi.fn(), reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  } catch {
    // Older jsdom exposes a non-configurable location; the assignment below
    // still resolves (navigation is a no-op) and does not fail the test.
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshSession", () => {
  it("rotates the access token and persists it in memory", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { access_token: "rotated-token" } }),
    );

    const token = await refreshSession();

    expect(token).toBe("rotated-token");
    expect(getAccessToken()).toBe("rotated-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("returns null when the refresh endpoint rejects", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));

    const token = await refreshSession();

    expect(token).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("dedupes concurrent calls into a single refresh request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { access_token: "shared-token" } }),
    );

    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);

    expect(a).toBe("shared-token");
    expect(b).toBe("shared-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("hydrateSession", () => {
  it("hydrates the in-memory user from /auth/me", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { user: { id: "u1", phone: "+919876543210", role: "VENDOR_OWNER" } },
      }),
    );

    const user = await hydrateSession();

    expect(user?.id).toBe("u1");
    expect(getSessionUser()?.role).toBe("VENDOR_OWNER");
  });

  it("returns null when there is no valid session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));

    const user = await hydrateSession();

    expect(user).toBeNull();
    expect(getSessionUser()).toBeNull();
  });
});

describe("logout", () => {
  it("clears the server session and local in-memory state", async () => {
    storeSession("access-123", { id: "u1", phone: "+919876543210", role: "VENDOR_OWNER" });
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));

    await logout();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/auth/logout", expect.anything());
    expect(getAccessToken()).toBeNull();
    expect(getSessionUser()).toBeNull();
  });
});

describe("authedFetch", () => {
  it("passes through on a successful response without refreshing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }, 200));

    const res = await authedFetch("/api/v1/orders");

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/orders", expect.anything());
  });

  it("silently refreshes and retries once on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { access_token: "fresh-token" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }, 200));

    const res = await authedFetch("/api/v1/orders");

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/orders", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/auth/refresh", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/orders", expect.anything());
    expect(getAccessToken()).toBe("fresh-token");
  });

  it("logs out and throws when refresh fails after 401", async () => {
    storeSession("access-123", { id: "u1", phone: "+919876543210", role: "VENDOR_OWNER" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401))
      .mockResolvedValueOnce(jsonResponse({}, 200));

    await expect(authedFetch("/api/v1/orders")).rejects.toThrow("Session expired");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/auth/refresh", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/auth/logout", expect.anything());
    expect(getSessionUser()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
