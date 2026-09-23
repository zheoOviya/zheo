import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWebSocket } from "../useWebSocket";
import { useAuthStore } from "@/lib/store";

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
  readonly openHandlers: Array<() => void> = [];
  readonly messageHandlers: Array<(event: { data: string }) => void> = [];
  readonly closeHandlers: Array<() => void> = [];
  readonly errorHandlers: Array<() => void> = [];

  private _onopen: (() => void) | null = null;
  private _onmessage: ((event: { data: string }) => void) | null = null;
  private _onclose: (() => void) | null = null;
  private _onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  set onopen(handler: (() => void) | null) {
    this._onopen = handler;
    if (handler) this.openHandlers.push(handler);
  }
  get onopen(): (() => void) | null {
    return this._onopen;
  }

  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this._onmessage = handler;
    if (handler) this.messageHandlers.push(handler);
  }
  get onmessage(): ((event: { data: string }) => void) | null {
    return this._onmessage;
  }

  set onclose(handler: (() => void) | null) {
    this._onclose = handler;
    if (handler) this.closeHandlers.push(handler);
  }
  get onclose(): (() => void) | null {
    return this._onclose;
  }

  set onerror(handler: (() => void) | null) {
    this._onerror = handler;
    if (handler) this.errorHandlers.push(handler);
  }
  get onerror(): (() => void) | null {
    return this._onerror;
  }
}

const instances = () => FakeWebSocket.instances;
const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

function setToken(token: string | null): void {
  act(() => {
    useAuthStore.setState({ accessToken: token });
  });
}

function statusEvent(orderId: string, sqlStatus: string): { data: string } {
  return {
    data: JSON.stringify({
      event: "ORDER_STATUS_UPDATE",
      data: {
        order_id: orderId,
        restaurant_id: "r1",
        sql_status: sqlStatus,
        ui_status: sqlStatus,
        timestamp: "2026-09-23T00:00:00.000Z",
      },
    }),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  useAuthStore.setState({
    accessToken: null,
    user: null,
    isAuthenticated: false,
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAuthStore.setState({
    accessToken: null,
    user: null,
    isAuthenticated: false,
  });
  FakeWebSocket.instances = [];
});

describe("useWebSocket lifecycle + token reauth", () => {
  it("1. null token creates no socket", () => {
    renderHook(() => useWebSocket("o1"));
    expect(instances()).toHaveLength(0);
  });

  it("2. valid token + orderId creates one socket and the URL carries the current token", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));

    expect(instances()).toHaveLength(1);
    expect(instances()[0]!.url).toContain("/api/v1/ws");
    expect(instances()[0]!.url).toContain("token=token-A");
  });

  it("3. onopen sends exactly the subscribe frame for the order", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));

    const socket = instances()[0]!;
    act(() => {
      socket.onopen?.();
    });

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "subscribe", order_id: "o1" }),
    ]);
  });

  it("4. a matching ORDER_STATUS_UPDATE exposes sql_status", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"));
    const socket = instances()[0]!;

    act(() => {
      socket.onmessage?.(statusEvent("o1", "PREPARING"));
    });

    expect(result.current.status).toBe("PREPARING");
  });

  it("5. an update for a different order is ignored", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"));
    const socket = instances()[0]!;

    act(() => {
      socket.onmessage?.(statusEvent("o2", "PREPARING"));
    });

    expect(result.current.status).toBeNull();
  });

  it("6. token A -> token B closes A, opens exactly one B using token B, resubscribes o1", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });

    setToken("token-B");

    expect(a.closeCalls).toBe(1);
    expect(instances()).toHaveLength(2);
    const b = instances()[1]!;
    expect(b.url).toContain("token=token-B");
    act(() => {
      b.onopen?.();
    });
    expect(b.sent).toEqual([
      JSON.stringify({ type: "subscribe", order_id: "o1" }),
    ]);
  });

  it("7. logout (token -> null) closes the active socket and opens no replacement", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });

    setToken(null);

    expect(a.closeCalls).toBe(1);
    expect(instances()).toHaveLength(1);
  });

  it("8. orderId o1 -> o2 closes the old socket and subscribes o2 on exactly one new socket", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { rerender } = renderHook(({ orderId }) => useWebSocket(orderId), {
      initialProps: { orderId: "o1" },
    });
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });

    rerender({ orderId: "o2" });

    expect(a.closeCalls).toBe(1);
    expect(instances()).toHaveLength(2);
    const b = instances()[1]!;
    act(() => {
      b.onopen?.();
    });
    expect(b.sent).toEqual([
      JSON.stringify({ type: "subscribe", order_id: "o2" }),
    ]);
  });

  it("9. a stale old-socket onclose cannot disconnect, clear ownership, or reconnect", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    const aLateClose = a.closeHandlers[0]!;
    act(() => {
      a.onopen?.();
    });
    expect(result.current.connected).toBe(true);

    setToken("token-B");
    const b = instances()[1]!;
    act(() => {
      b.onopen?.();
    });
    expect(result.current.connected).toBe(true);

    act(() => {
      aLateClose();
    });
    expect(result.current.connected).toBe(true);
    expect(b.closeCalls).toBe(0);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(2);
  });

  it("10. a genuine current-socket close reconnects after exactly 500ms with one replacement", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });

    act(() => {
      a.onclose?.();
    });
    expect(result.current.connected).toBe(false);

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(instances()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(instances()).toHaveLength(2);
  });

  it("11. an old reconnect timer is cancelled after a token lifecycle change", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    act(() => {
      a.onclose?.();
    });
    expect(instances()).toHaveLength(1);

    setToken("token-B");
    expect(instances()).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(2);
  });

  it("12. unmount closes the active socket and a late onclose creates no replacement", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { unmount } = renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    const aLateClose = a.closeHandlers[0]!;

    unmount();
    expect(a.closeCalls).toBe(1);

    act(() => {
      aLateClose();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(1);
  });

  it("13. StrictMode replay: a late close from a superseded socket cannot clobber the current one", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });

    const first = instances()[0]!;
    const firstLateClose = first.closeHandlers[0]!;
    act(() => {
      first.onopen?.();
    });
    expect(result.current.connected).toBe(true);

    // Force an effect replay (cleanup + setup) on the same hook instance.
    // React 19.2 does not double-invoke effects in this test environment, so
    // the StrictMode replay sequence is driven deterministically here.
    setToken("token-B");
    const middle = instances()[1]!;
    setToken("token-A");
    const current = instances()[2]!;
    expect(current).not.toBe(first);
    act(() => {
      current.onopen?.();
    });
    expect(result.current.connected).toBe(true);

    // The superseded first socket's callback fires late.
    act(() => {
      firstLateClose();
    });
    expect(result.current.connected).toBe(true);
    expect(current.closeCalls).toBe(0);
    expect(middle.closeCalls).toBe(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(3);
    expect(latest()).toBe(current);
  });

  it("14. retry cap remains 10 and never exceeds MAX_RETRIES", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket("o1"));

    for (let i = 0; i < 10; i += 1) {
      // No onopen here: model repeated failed connections, so the retry budget
      // is consumed cumulatively rather than reset by a successful handshake.
      const socket = latest();
      act(() => {
        socket.onclose?.();
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
    }

    expect(instances()).toHaveLength(11);

    const finalSocket = latest();
    act(() => {
      finalSocket.onclose?.();
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(instances()).toHaveLength(11);
  });

  it("15. unmount clears a pending reconnect timer", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { unmount } = renderHook(() => useWebSocket("o1"));
    const a = instances()[0]!;
    act(() => {
      a.onopen?.();
    });
    act(() => {
      a.onclose?.();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(instances()).toHaveLength(1);
  });

  it("16. a null orderId with a valid token opens no socket", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    renderHook(() => useWebSocket(null));
    expect(instances()).toHaveLength(0);
  });

  it("17. a malformed message is ignored without throwing", () => {
    useAuthStore.setState({ accessToken: "token-A" });
    const { result } = renderHook(() => useWebSocket("o1"));
    const socket = instances()[0]!;

    expect(() => {
      act(() => {
        socket.onmessage?.({ data: "not-json" });
      });
    }).not.toThrow();
    expect(result.current.status).toBeNull();
  });
});
