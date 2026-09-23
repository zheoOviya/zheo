import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { GroupCartView } from "../GroupCartView";
import {
  fetchGroupCart,
  type GroupCartSnapshot,
} from "@/lib/api";

const storeMocks = vi.hoisted(() => {
  const clear = vi.fn();
  const cart = {
    items: [] as Array<{
      menuItemId: string;
      quantity: number;
      customizations: Array<{ price_delta: number }>;
    }>,
    restaurantId: null as string | null,
    clear,
  };
  const auth = { accessToken: "test-token" as string | null };
  return { clear, cart, auth };
});

vi.mock("@/lib/store", () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(storeMocks.auth) : storeMocks.auth,
  useCartStore: (selector?: (s: unknown) => unknown) =>
    selector ? selector(storeMocks.cart) : storeMocks.cart,
}));

vi.mock("@/lib/api", () => ({
  fetchGroupCart: vi.fn(),
  addToGroupCart: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: unknown;
    children: ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = vi.mocked(fetchGroupCart);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(
  overrides: Partial<GroupCartSnapshot> = {},
): GroupCartSnapshot {
  return {
    group_cart_token: "g1",
    restaurant_id: "r1",
    order_id: "o1",
    status: "DRAFT",
    item_count: 0,
    total_amount: 0,
    items: [],
    contributors: [],
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

let visibility: DocumentVisibilityState = "visible";
let online = true;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
}

function setOnline(next: boolean) {
  online = next;
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
}

const emitVisibility = (next: DocumentVisibilityState) => {
  setVisibility(next);
  return act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

const emitOnline = (next: boolean) => {
  setOnline(next);
  return act(async () => {
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const flush = () => advance(0);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  storeMocks.clear.mockReset();
  storeMocks.cart.items = [];
  storeMocks.cart.restaurantId = null;
  storeMocks.auth.accessToken = "test-token";
  setVisibility("visible");
  setOnline(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  delete (navigator as unknown as { onLine?: unknown }).onLine;
});

describe("GroupCartView bounded polling", () => {
  it("fetches immediately on mount when visible and online", async () => {
    fetchMock.mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("t1");
    expect(screen.getByText("Live Group Cart")).toBeInTheDocument();
    expect(
      screen.getByText("Open - anyone with the link can add items"),
    ).toBeInTheDocument();
  });

  it("schedules the next automatic fetch only after the prior request settles", async () => {
    const first = deferred<GroupCartSnapshot>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Timer would have fired here under the old setInterval; new cadence waits.
    await advance(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(snapshot());
    });
    await flush();

    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not overlap: advancing well past the interval keeps a single in-flight call", async () => {
    const first = deferred<GroupCartSnapshot>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(snapshot());
    });
  });

  it("polls again 2000ms after a successful DRAFT snapshot", async () => {
    fetchMock.mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops automatic polling on a non-DRAFT snapshot", async () => {
    fetchMock.mockResolvedValue(snapshot({ status: "CLOSED" }));

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Closed - order status: CLOSED"),
    ).toBeInTheDocument();

    await advance(20000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses while hidden and resumes with an immediate refresh on visible", async () => {
    fetchMock.mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await emitVisibility("hidden");
    await advance(20000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await emitVisibility("visible");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("pauses while offline and resumes with an immediate refresh on online", async () => {
    fetchMock.mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await emitOnline(false);
    await advance(20000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await emitOnline(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks a stale old-token response from overwriting the current token snapshot", async () => {
    const first = deferred<GroupCartSnapshot>();
    const second = deferred<GroupCartSnapshot>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<GroupCartView token="t2" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(snapshot({ status: "CLOSED" }));
    });
    await act(async () => {
      second.resolve(snapshot({ status: "DRAFT" }));
    });
    await flush();

    expect(
      screen.getByText("Open - anyone with the link can add items"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Closed - order status: CLOSED")).toBeNull();
  });

  it("retries a failure no sooner than ERROR_RETRY_MS", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(snapshot());

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("boom")).toBeInTheDocument();

    await advance(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("manual Try Again uses the same single-flight path", async () => {
    const second = deferred<GroupCartSnapshot>();
    fetchMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockReturnValueOnce(second.promise);

    render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The armed 5000ms retry was cleared by the manual refresh: no third call.
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(snapshot());
    });
    await flush();
    expect(screen.getByText("Live Group Cart")).toBeInTheDocument();
  });

  it("removes lifecycle listeners on unmount", async () => {
    fetchMock.mockResolvedValue(snapshot());

    const { unmount } = render(<GroupCartView token="t1" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await emitVisibility("hidden");
    await emitVisibility("visible");
    await emitOnline(false);
    await emitOnline(true);
    await advance(20000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
