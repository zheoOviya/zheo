import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDashboardMetrics,
  fetchHealth,
  fetchHeatmap,
  overrideOrderStatus,
  updateUserRole,
} from "../lib/api";

// A2c-A2 fetch-robustness contract tests (FR-1 .. FR-15 + negative invariants).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const html = (status: number) =>
  new Response("<html><body>upstream boom</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });

const empty = (status: number) => new Response(null, { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const API_SRC = read("../lib/api.ts");

const callUrl = (index: number): unknown => fetchMock.mock.calls[index]?.[0];

describe("FR-1 200 JSON returns parsed data", () => {
  it("resolves with the envelope data", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { revenue_today: 42 }, error: null }),
    );
    await expect(fetchDashboardMetrics()).resolves.toEqual({ revenue_today: 42 });
  });
});

describe("FR-2 201 JSON returns parsed data", () => {
  it("resolves with the envelope data", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { status: "ok" }, error: null }, 201),
    );
    await expect(fetchHealth()).resolves.toEqual({ status: "ok" });
  });
});

describe("FR-3 non-2xx JSON rejects with safe backend message", () => {
  it("uses body.error.message and never returns data", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { success: false, data: null, error: { code: "X", message: "Backend said no" } },
        400,
      ),
    );
    await expect(fetchDashboardMetrics()).rejects.toThrow("Backend said no");
  });

  it("falls back to body.message then HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: false, message: "top level" }, 403));
    await expect(fetchDashboardMetrics()).rejects.toThrow("top level");

    fetchMock.mockResolvedValueOnce(json({ success: false }, 500));
    await expect(fetchDashboardMetrics()).rejects.toThrow("HTTP 500");
  });
});

describe("FR-4 non-2xx non-JSON is deterministic, not SyntaxError", () => {
  it("rejects with an Error carrying only the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(html(500));
    let caught: unknown;
    try {
      await fetchHealth();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as Error).message).toBe("HTTP 500");
    expect((caught as Error).message).not.toContain("html");
  });
});

describe("FR-5 network rejection", () => {
  it("rejects predictably with no retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchHealth()).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FR-6 first 401 + successful refresh retries exactly once", () => {
  it("runs the original request exactly twice and returns the retried data", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired" } }, 401),
      )
      .mockResolvedValueOnce(json({ success: true, data: { ok: true }, error: null }, 200))
      .mockResolvedValueOnce(
        json({ success: true, data: { revenue_today: 7 }, error: null }, 200),
      );
    await expect(fetchDashboardMetrics()).resolves.toEqual({ revenue_today: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callUrl(0)).toBe("/api/v1/admin/metrics");
    expect(callUrl(1)).toBe("/api/v1/auth/refresh");
    expect(callUrl(2)).toBe("/api/v1/admin/metrics");
  });
});

describe("FR-7 refresh non-2xx does not retry the original", () => {
  it("rejects deterministically and preserves the login outcome", async () => {
    const fakeWindow = { location: { href: "" } };
    vi.stubGlobal("window", fakeWindow);
    fetchMock
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired" } }, 401),
      )
      .mockResolvedValueOnce(json({ success: true, data: {}, error: null }, 500));
    await expect(fetchDashboardMetrics()).rejects.toThrow("expired");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fakeWindow.location.href).toBe("/login");
  });
});

describe("FR-8 refresh invalid/empty JSON", () => {
  it("fails deterministically without SyntaxError and without a retry", async () => {
    const fakeWindow = { location: { href: "" } };
    vi.stubGlobal("window", fakeWindow);
    fetchMock
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired" } }, 401),
      )
      .mockResolvedValueOnce(html(200));
    let caught: unknown;
    try {
      await fetchDashboardMetrics();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fakeWindow.location.href).toBe("/login");
  });
});

describe("FR-9 retried original non-2xx rejects", () => {
  it("rejects after a successful refresh when the replay fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired" } }, 401),
      )
      .mockResolvedValueOnce(json({ success: true, data: {}, error: null }, 200))
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "still down" } }, 400),
      );
    await expect(fetchDashboardMetrics()).rejects.toThrow("still down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("FR-10 second 401 after refresh does not loop", () => {
  it("does not refresh a second time", async () => {
    const fakeWindow = { location: { href: "" } };
    vi.stubGlobal("window", fakeWindow);
    fetchMock
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired" } }, 401),
      )
      .mockResolvedValueOnce(json({ success: true, data: {}, error: null }, 200))
      .mockResolvedValueOnce(
        json({ success: false, data: null, error: { message: "expired again" } }, 401),
      );
    await expect(fetchDashboardMetrics()).rejects.toThrow("expired again");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/v1/auth/refresh",
    );
    expect(refreshCalls).toHaveLength(1);
    expect(fakeWindow.location.href).toBe("/login");
  });
});

describe("FR-11 fetchHeatmap follows the robust policy", () => {
  it("resolves on a 200 valid payload", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { cells: [], total_orders: 0 }, error: null }),
    );
    await expect(fetchHeatmap()).resolves.toEqual({ cells: [], total_orders: 0 });
  });

  it("rejects on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(html(502));
    await expect(fetchHeatmap()).rejects.toThrow("HTTP 502");
  });

  it("rejects deterministically on non-JSON", async () => {
    fetchMock.mockResolvedValueOnce(html(500));
    await expect(fetchHeatmap()).rejects.toThrow("HTTP 500");
  });

  it("rejects when required data is missing", async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: null, error: null }));
    await expect(fetchHeatmap()).rejects.toThrow("Request failed");
  });

  it("never invokes the admin refresh path", async () => {
    fetchMock.mockResolvedValueOnce(html(401));
    await expect(fetchHeatmap()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callUrl(0)).toBe("/api/v1/discovery/heatmap");
  });
});

describe("FR-12 six pages normalize unknown caught values", () => {
  const pages: Record<string, string> = {
    dashboard: "../app/(admin)/dashboard/page.tsx",
    orders: "../app/(admin)/orders/page.tsx",
    "support-tickets": "../app/(admin)/support-tickets/page.tsx",
    users: "../app/(admin)/users/page.tsx",
    "audit-logs": "../app/(admin)/audit-logs/page.tsx",
    "kill-switches": "../app/(admin)/kill-switches/page.tsx",
  };

  for (const [name, rel] of Object.entries(pages)) {
    it(`${name} never reads e.message without an Error guard`, () => {
      const src = read(rel);
      expect(src).toContain("e instanceof Error ? e.message");
      expect(src).not.toMatch(/setError\(\s*e\.message\s*\)/);
    });
  }
});

describe("FR-13 request contract unchanged", () => {
  it("read uses GET + include credentials + JSON content type", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { status: "ok" }, error: null }),
    );
    await fetchHealth();
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected a fetch call");
    const [url, init] = call;
    expect(url).toBe("/api/v1/admin/health");
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe("include");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("mutation preserves method, JSON body and headers", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: { id: "u1" }, error: null }),
    );
    await updateUserRole("u1", "ADMIN");
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected a fetch call");
    const [url, init] = call;
    expect(url).toBe("/api/v1/admin/users/u1/role");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ role: "ADMIN" });
  });
});

describe("FR-14 mutation gains no generic retry behavior", () => {
  it("a network failure issues exactly one request", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      overrideOrderStatus("o1", "PREPARING", "CONFIRMED"),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FR-15 generic empty 2xx contract", () => {
  it("204 resolves undefined without SyntaxError", async () => {
    fetchMock.mockResolvedValueOnce(empty(204));
    await expect(fetchDashboardMetrics()).resolves.toBeUndefined();
  });

  it("200 with an empty body resolves undefined", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(fetchDashboardMetrics()).resolves.toBeUndefined();
  });
});

describe("A2c negative invariants", () => {
  it("api.ts adds no abort, timeout, generic retry, or custom error class", () => {
    expect(API_SRC).not.toMatch(/AbortController|AbortSignal/);
    expect(API_SRC).not.toMatch(/setTimeout|setInterval/);
    expect(API_SRC).not.toMatch(/class\s+\w*Error/);
    expect(API_SRC).not.toMatch(/AdminApiError/);
  });
});
