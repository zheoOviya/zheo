import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOrdersWebSocket } from "../useOrdersWebSocket";
import { clearSession, storeSession } from "@/lib/auth";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCalls = 0;
  closeCode: number | undefined;
  private _onopen: (() => void) | null = null;
  private _onmessage: ((event: { data: string }) => void) | null = null;
  private _onclose: ((event?: { code?: number }) => void) | null = null;
  private _onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCalls += 1;
    this.closeCode = code;
    this.readyState = FakeWebSocket.CLOSED;
  }

  set onopen(handler: (() => void) | null) {
    this._onopen = handler;
  }
  get onopen(): (() => void) | null {
    return this._onopen;
  }
  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this._onmessage = handler;
  }
  get onmessage(): ((event: { data: string }) => void) | null {
    return this._onmessage;
  }
  set onclose(handler: ((event?: { code?: number }) => void) | null) {
    this._onclose = handler;
  }
  get onclose(): ((event?: { code?: number }) => void) | null {
    return this._onclose;
  }
  set onerror(handler: (() => void) | null) {
    this._onerror = handler;
  }
  get onerror(): (() => void) | null {
    return this._onerror;
  }
}

const instances = () => FakeWebSocket.instances;
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

beforeEach(() => {
  FakeWebSocket.instances = [];
  clearSession();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearSession();
  FakeWebSocket.instances = [];
});

describe("useOrdersWebSocket AUTH-G4 query-token removal", () => {
  it("CLIENT-2 constructor URL has no token query even when JS access token exists", () => {
    storeSession("vendor-jwt-literal", {
      id: "v1",
      phone: "+919800000001",
      role: "VENDOR_OWNER",
    });
    renderHook(() => useOrdersWebSocket("rest-1"));
    expect(instances()).toHaveLength(1);
    expect(instances()[0]!.url).toContain("/api/v1/ws");
    expect(instances()[0]!.url).not.toMatch(/[?&]token=/);
    expect(instances()[0]!.url).not.toContain("vendor-jwt-literal");
  });

  it("CLIENT-3 JWT literal never appears in constructed WS URL", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ2MSJ9.signature";
    storeSession(jwt, {
      id: "v1",
      phone: "+919800000001",
      role: "VENDOR_OWNER",
    });
    renderHook(() => useOrdersWebSocket("rest-1"));
    expect(instances()[0]!.url).not.toContain(jwt);
    expect(instances()[0]!.url).not.toContain(encodeURIComponent(jwt));
    expect(instances()[0]!.url).not.toMatch(/[?&]token=/);
  });

  it("opens with restaurantId even when JS access token is absent (cookie handshake)", () => {
    renderHook(() => useOrdersWebSocket("rest-1"));
    expect(instances()).toHaveLength(1);
    expect(instances()[0]!.url).not.toMatch(/[?&]token=/);
  });

  it("onopen sends subscribe_restaurant for the restaurant", () => {
    renderHook(() => useOrdersWebSocket("rest-1"));
    const socket = instances()[0]!;
    act(() => {
      socket.onopen?.();
    });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "subscribe_restaurant", restaurant_id: "rest-1" }),
    ]);
  });

  it("CLIENT-5 unmount closes the socket and a late onclose creates no replacement", () => {
    const { unmount } = renderHook(() => useOrdersWebSocket("rest-1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    unmount();
    expect(a.closeCalls).toBeGreaterThanOrEqual(1);
    act(() => {
      a.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(1);
  });

  it("CLIENT-5 a genuine current-socket close reconnects after 500ms", () => {
    renderHook(() => useOrdersWebSocket("rest-1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    act(() => {
      a.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(instances()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(instances()).toHaveLength(2);
    expect(latest().url).not.toMatch(/[?&]token=/);
  });

  it("policy close 1008 does not schedule a reconnect", () => {
    renderHook(() => useOrdersWebSocket("rest-1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    act(() => {
      a.onclose?.({ code: 1008 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(1);
  });
});
