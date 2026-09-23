import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import OrderTrackingPage from "./page";
import { useAuthStore } from "@/lib/store";
import {
  fetchRestaurants,
  fetchStampCard,
  fetchTrafficEta,
  type Restaurant,
  type StampCard,
  type TrafficEta,
} from "@/lib/api";

const navMock = vi.hoisted(() => ({ id: "o1" }));
const trackerProps = vi.hoisted(() => ({
  current: null as null | {
    initialStatus?: string;
    onStatusChange?: (status: string) => void;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: navMock.id }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/AuthGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/OrderTracker", () => ({
  OrderTracker: (props: {
    initialStatus: string;
    onStatusChange?: (status: string) => void;
  }) => {
    trackerProps.current = props;
    return <div data-testid="order-tracker">{props.initialStatus}</div>;
  },
}));

vi.mock("@/components/QrCode", () => ({
  QrCode: ({ otp }: { otp: string }) => <div data-testid="qr-code">{otp}</div>,
}));

vi.mock("@/lib/api", () => ({
  fetchRestaurants: vi.fn(),
  fetchStampCard: vi.fn(),
  fetchTrafficEta: vi.fn(),
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default:
      (
        loader: () => Promise<{
          default: ComponentType<Record<string, unknown>>;
        }>,
      ) =>
      (props: Record<string, unknown>) => {
        const [Comp, setComp] = React.useState<ComponentType<
          Record<string, unknown>
        > | null>(null);
        React.useEffect(() => {
          let active = true;
          Promise.resolve(loader()).then((mod) => {
            if (active) setComp(() => mod.default);
          });
          return () => {
            active = false;
          };
        }, []);
        return Comp ? <Comp {...props} /> : null;
      },
  };
});

const fetchMock = vi.fn();

interface OrderData {
  id: string;
  restaurant_id: string;
  status: string;
  pickup_otp: string | null;
  qr_token: string | null;
  total_amount: number;
  items: Array<{ name: string; quantity: number }>;
  checked_in: boolean;
}

function orderData(overrides: Partial<OrderData> = {}): OrderData {
  return {
    id: "o1",
    restaurant_id: "r1",
    status: "CONFIRMED",
    pickup_otp: null,
    qr_token: null,
    total_amount: 100,
    items: [{ name: "Burger", quantity: 1 }],
    checked_in: false,
    ...overrides,
  };
}

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  } as Response;
}

function success(data: OrderData): Response {
  return response({ success: true, data });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const restaurant = (id: string): Restaurant =>
  ({ id, lat: 19.07, lng: 72.87 }) as unknown as Restaurant;

const restaurantWithCoords = (
  id: string,
  lat: number,
  lng: number,
): Restaurant => ({ id, lat, lng }) as unknown as Restaurant;

const restaurantWithoutCoords = (id: string): Restaurant =>
  ({ id, lat: undefined, lng: undefined }) as unknown as Restaurant;

function stubGeolocation(value: unknown) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value,
  });
}

const stampCard: StampCard = {
  user_id: "u1",
  restaurant_id: "r1",
  stamp_count: 0,
  total_orders: 0,
  rewards_earned: 0,
  reward_type: "FREE_ITEM",
  updated_at: "",
};

const trafficEta: TrafficEta = {
  eta_seconds: 300,
  duration_text: "5 min",
  distance_km: 1,
  source: "heuristic",
};

const notify = (status: string) =>
  act(async () => {
    trackerProps.current?.onStatusChange?.(status);
  });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  navMock.id = "o1";
  trackerProps.current = null;
  useAuthStore.setState({ accessToken: "token-a" });
  vi.mocked(fetchRestaurants).mockReset().mockResolvedValue([]);
  vi.mocked(fetchStampCard).mockReset().mockResolvedValue(stampCard);
  vi.mocked(fetchTrafficEta).mockReset().mockResolvedValue(trafficEta);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe("order detail freshness", () => {
  it("1. fetches the order once on mount", async () => {
    fetchMock.mockResolvedValue(success(orderData()));

    render(<OrderTrackingPage />);

    expect(await screen.findByTestId("order-tracker")).toHaveTextContent(
      "CONFIRMED",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/orders/o1",
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer token-a" },
      }),
    );
  });

  it("2. refetches exactly once on a genuine WebSocket status notification", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "PREPARING" })));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    await notify("PREPARING");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("order-tracker")).toHaveTextContent("PREPARING"),
    );
  });

  it("3. suppresses a duplicate notification for the same status", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "PREPARING" })));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    await notify("PREPARING");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await notify("PREPARING");
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("4. coalesces notifications received while a refetch is in flight", async () => {
    fetchMock.mockResolvedValueOnce(success(orderData()));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    const inFlight = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(success(orderData({ status: "READY_FOR_PICKUP" })));

    await notify("PREPARING");
    await notify("ALMOST_READY");
    await notify("READY_FOR_PICKUP");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      inFlight.resolve(success(orderData({ status: "PREPARING" })));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("5. shows QR/OTP from the authoritative READY_FOR_PICKUP snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(
        success(
          orderData({
            status: "READY_FOR_PICKUP",
            qr_token: "qr-1",
            pickup_otp: "123456",
          }),
        ),
      );

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");
    expect(screen.queryByTestId("qr-code")).toBeNull();

    await notify("READY_FOR_PICKUP");

    expect(await screen.findByTestId("qr-code")).toHaveTextContent("123456");
  });

  it("6. shows the pickup confirmation from the authoritative PICKED_UP snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "PICKED_UP" })));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    await notify("PICKED_UP");

    expect(await screen.findByText("Order Picked Up!")).toBeInTheDocument();
  });

  it("7. ignores an old-lifecycle response after a token transition", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<OrderTrackingPage />);

    await act(async () => {
      useAuthStore.setState({ accessToken: "token-b" });
    });

    await act(async () => {
      first.resolve(success(orderData({ status: "CANCELLED" })));
    });
    await act(async () => {
      second.resolve(success(orderData({ status: "CONFIRMED" })));
    });

    await screen.findByTestId("order-tracker");
    expect(trackerProps.current?.initialStatus).toBe("CONFIRMED");
    expect(screen.queryByText("Cancelled")).toBeNull();
  });

  it("8. ignores a response that settles after unmount", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);

    const { unmount, container } = render(<OrderTrackingPage />);
    unmount();

    await act(async () => {
      pending.resolve(success(orderData()));
    });

    expect(container).toBeEmptyDOMElement();
  });

  it("9. a status refresh does not retrigger ETA or stamp-card fetches", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "PREPARING" })));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");
    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(1));
    expect(fetchRestaurants).toHaveBeenCalledTimes(1);
    expect(fetchStampCard).toHaveBeenCalledTimes(1);

    await notify("PREPARING");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("order-tracker")).toHaveTextContent("PREPARING"),
    );

    expect(fetchRestaurants).toHaveBeenCalledTimes(1);
    expect(fetchStampCard).toHaveBeenCalledTimes(1);
    expect(fetchTrafficEta).toHaveBeenCalledTimes(1);
  });

  it("10. a restaurant change refreshes ETA and stamp card", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(
        success(orderData({ status: "PREPARING", restaurant_id: "r2" })),
      );
    vi.mocked(fetchRestaurants).mockResolvedValue([
      restaurant("r1"),
      restaurant("r2"),
    ]);

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");
    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(1));

    await notify("PREPARING");

    await waitFor(() => expect(fetchRestaurants).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchStampCard).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(2));
  });

  it("11. a token change refreshes the authenticated stamp card", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");
    await waitFor(() => expect(fetchStampCard).toHaveBeenCalledTimes(1));

    await act(async () => {
      useAuthStore.setState({ accessToken: "token-b" });
    });

    await waitFor(() => expect(fetchStampCard).toHaveBeenCalledTimes(2));
    expect(fetchTrafficEta).toHaveBeenCalledTimes(1);
  });

  it("12. a failed refresh preserves the last valid snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockRejectedValueOnce(new Error("Order not found"));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    await notify("PREPARING");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});

    expect(trackerProps.current?.initialStatus).toBe("CONFIRMED");
    expect(screen.queryByText("Order not found")).toBeNull();
  });

  it("13. hides check-in for an authoritative CANCELLED snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "CANCELLED" })));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");
    expect(
      screen.getByRole("button", { name: "I am Here (Check In)" }),
    ).toBeInTheDocument();

    await notify("CANCELLED");
    await waitFor(() =>
      expect(screen.getByTestId("order-tracker")).toHaveTextContent("CANCELLED"),
    );

    expect(
      screen.queryByRole("button", { name: "I am Here (Check In)" }),
    ).toBeNull();
  });

  it("14. hides check-in for an authoritative PAYMENT_FAILED snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(success(orderData({ status: "PAYMENT_FAILED" })));

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    await notify("PAYMENT_FAILED");
    await waitFor(() =>
      expect(screen.getByTestId("order-tracker")).toHaveTextContent(
        "PAYMENT_FAILED",
      ),
    );

    expect(
      screen.queryByRole("button", { name: "I am Here (Check In)" }),
    ).toBeNull();
  });

  it("15. an old-lifecycle request cannot release the current lifecycle's single-flight guard", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(success(orderData())) // initial lifecycle 1
      .mockReturnValueOnce(a.promise) // request A (lifecycle 1 refresh)
      .mockReturnValueOnce(b.promise) // request B (lifecycle 2 initial)
      .mockResolvedValue(success(orderData({ status: "CONFIRMED" }))); // coalesced follow-up

    render(<OrderTrackingPage />);
    await screen.findByTestId("order-tracker");

    // Request A starts for lifecycle 1 and stays unresolved.
    await notify("PREPARING");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Lifecycle 2 (token change) starts request B while A is still unresolved.
    await act(async () => {
      useAuthStore.setState({ accessToken: "token-b" });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // A settles late. Its finally must not release B's single-flight guard.
    await act(async () => {
      a.resolve(success(orderData({ status: "CANCELLED" })));
    });

    // A WS notification while B is unresolved must be coalesced, not start a
    // third concurrent request.
    await notify("ALMOST_READY");
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // B settles: exactly one coalesced follow-up may start, and no more.
    await act(async () => {
      b.resolve(success(orderData({ status: "CONFIRMED" })));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("eta truth and location disclosure", () => {
  function geoSuccess() {
    stubGeolocation({
      getCurrentPosition: (success: (pos: unknown) => void) =>
        success({ coords: { latitude: 10, longitude: 20 } }),
    });
  }

  function geoError(code: number) {
    stubGeolocation({
      getCurrentPosition: (_success: unknown, error: (err: unknown) => void) =>
        error({ code }),
    });
  }

  it("shows a Live traffic badge and live copy for a google-source ETA", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    vi.mocked(fetchTrafficEta).mockResolvedValue({
      ...trafficEta,
      source: "google",
    });
    geoSuccess();

    render(<OrderTrackingPage />);

    expect(await screen.findByText("Live traffic")).toBeInTheDocument();
    expect(
      screen.getByText("Based on live traffic from Google Maps."),
    ).toBeInTheDocument();
  });

  it("shows an Estimated badge and truthful heuristic copy for a heuristic ETA", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    geoSuccess();

    render(<OrderTrackingPage />);

    expect(await screen.findByText("Estimated")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated travel time based on distance and typical traffic.",
      ),
    ).toBeInTheDocument();
  });

  it("does not disclose an approximate location when geolocation succeeds", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    geoSuccess();

    render(<OrderTrackingPage />);
    await screen.findByText("Estimated");

    expect(
      screen.queryByText("Using an approximate starting location."),
    ).toBeNull();
  });

  it("discloses an approximate location when geolocation is denied", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    geoError(1);

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("Using an approximate starting location."),
    ).toBeInTheDocument();
  });

  it("discloses an approximate location when geolocation errors or times out", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    geoError(3);

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("Using an approximate starting location."),
    ).toBeInTheDocument();
  });

  it("discloses an approximate location when geolocation is unavailable", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    stubGeolocation(undefined);

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("Using an approximate starting location."),
    ).toBeInTheDocument();
  });

  it("attempts the ETA request when the restaurant latitude is 0", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([
      restaurantWithCoords("r1", 0, 72.87),
    ]);
    geoSuccess();

    render(<OrderTrackingPage />);

    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(1));
  });

  it("attempts the ETA request when the restaurant longitude is 0", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([
      restaurantWithCoords("r1", 19.07, 0),
    ]);
    geoSuccess();

    render(<OrderTrackingPage />);

    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(1));
  });

  it("preserves the ETA-unavailable message when the ETA fetch fails", async () => {
    fetchMock.mockResolvedValue(success(orderData()));
    vi.mocked(fetchRestaurants).mockResolvedValue([restaurant("r1")]);
    vi.mocked(fetchTrafficEta).mockRejectedValue(new Error("eta down"));
    geoSuccess();

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("ETA unavailable for this restaurant."),
    ).toBeInTheDocument();
  });

  it("clears the fallback disclosure when a later restaurant uses a real origin", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(
        success(orderData({ status: "PREPARING", restaurant_id: "r2" })),
      );
    vi.mocked(fetchRestaurants).mockResolvedValue([
      restaurant("r1"),
      restaurant("r2"),
    ]);
    geoError(1);

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("Using an approximate starting location."),
    ).toBeInTheDocument();

    geoSuccess();
    await notify("PREPARING");

    await waitFor(() => expect(fetchTrafficEta).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Using an approximate starting location."),
      ).toBeNull(),
    );
  });

  it("keeps the fallback disclosure hidden when the next restaurant has invalid coordinates", async () => {
    fetchMock
      .mockResolvedValueOnce(success(orderData()))
      .mockResolvedValue(
        success(orderData({ status: "PREPARING", restaurant_id: "r2" })),
      );
    vi.mocked(fetchRestaurants).mockResolvedValue([
      restaurant("r1"),
      restaurantWithoutCoords("r2"),
    ]);
    vi.mocked(fetchTrafficEta).mockRejectedValue(new Error("eta down"));
    geoError(1);

    render(<OrderTrackingPage />);

    expect(
      await screen.findByText("Using an approximate starting location."),
    ).toBeInTheDocument();

    await notify("PREPARING");

    await waitFor(() => expect(fetchRestaurants).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Using an approximate starting location."),
      ).toBeNull(),
    );
    expect(
      screen.getByText("ETA unavailable for this restaurant."),
    ).toBeInTheDocument();
  });
});
