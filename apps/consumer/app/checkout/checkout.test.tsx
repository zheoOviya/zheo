import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CheckoutPage from "./page";
import { useAuthStore, useCartStore } from "@/lib/store";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

describe("CheckoutPage", () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "tok-123",
      user: { id: "u1", phone: "9876543210", role: "CONSUMER" },
      isAuthenticated: true,
    });
    useCartStore.setState({
      items: [
        {
          menuItemId: "m1",
          name: "Paneer Tikka",
          basePrice: 200,
          quantity: 1,
          customizations: [],
          restaurantId: "r1",
          restaurantName: "Spice Route",
        },
      ],
      restaurantId: "r1",
      restaurantName: "Spice Route",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers payment and continue-shopping without a sign-out action", async () => {
    render(<CheckoutPage />);

    expect(await screen.findByText(/Place Pickup Order/)).toBeDefined();
    expect(screen.getByRole("button", { name: /Continue Shopping/ })).toBeDefined();

    expect(screen.queryByRole("button", { name: "Sign Out" })).toBeNull();
    expect(screen.queryByText("Sign Out")).toBeNull();
  });

  it("renders the global header with the account menu", async () => {
    render(<CheckoutPage />);

    expect(screen.getByRole("link", { name: "SnakZap home" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Account menu" })).toBeDefined();
  });

  it("shows the suspension banner for a suspended account", async () => {
    useAuthStore.setState({
      user: { id: "u1", phone: "9876543210", role: "CONSUMER", is_suspended: true },
    });

    render(<CheckoutPage />);

    expect(await screen.findByText(/suspended/)).toBeDefined();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function nonJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token '<' in JSON at position 0")),
  } as unknown as Response;
}

const SLOT = {
  time: "10:00",
  label: "10:00",
  available: true,
  current_orders: 0,
  max_capacity: 3,
};

function slotsEnvelope(slots: unknown[]) {
  return { success: true, data: { restaurant_id: "r1", date: "2026-09-21", slots }, error: null };
}

describe("CheckoutPage pickup slots", () => {
  let pickupResponder: () => Promise<Response>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  const pickupCallCount = () =>
    fetchSpy.mock.calls.filter(([input]) => String(input).includes("/pickup-slots")).length;

  function openScheduleGrid() {
    fireEvent.click(screen.getByRole("radio", { name: /Schedule for later/ }));
  }

  beforeEach(() => {
    useAuthStore.setState({
      accessToken: "tok-123",
      user: { id: "u1", phone: "9876543210", role: "CONSUMER" },
      isAuthenticated: true,
    });
    useCartStore.setState({
      items: [
        {
          menuItemId: "m1",
          name: "Paneer Tikka",
          basePrice: 200,
          quantity: 1,
          customizations: [],
          restaurantId: "r1",
          restaurantName: "Spice Route",
        },
      ],
      restaurantId: "r1",
      restaurantName: "Spice Route",
    });

    pickupResponder = () => Promise.resolve(jsonResponse(200, slotsEnvelope([])));
    fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pickup-slots")) return pickupResponder();
      return Promise.reject(new Error("unmocked"));
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    vi.clearAllMocks();
  });

  it("renders valid non-empty slots", async () => {
    pickupResponder = () => Promise.resolve(jsonResponse(200, slotsEnvelope([SLOT])));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByRole("radio", { name: "10:00" })).toBeDefined();
    expect(screen.queryByText("Failed to load slots")).toBeNull();
  });

  it("renders a valid empty list without error or crash", async () => {
    pickupResponder = () => Promise.resolve(jsonResponse(200, slotsEnvelope([])));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(
      await screen.findByRole("radiogroup", { name: "Available pickup time slots" }),
    ).toBeDefined();
    expect(screen.queryByText("Failed to load slots")).toBeNull();
  });

  it("shows a normalized error for a non-2xx response", async () => {
    pickupResponder = () =>
      Promise.resolve(
        jsonResponse(500, { success: false, data: null, error: { code: "X", message: "boom" } }),
      );

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
  });

  it("normalizes a non-JSON body without leaking SyntaxError", async () => {
    pickupResponder = () => Promise.resolve(nonJsonResponse(200));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
    expect(screen.queryByText(/Unexpected token|SyntaxError/)).toBeNull();
  });

  it.each([
    ["wrong envelope", { foo: 1 }],
    ["data:null", { success: true, data: null, error: null }],
    ["slots missing", { success: true, data: {}, error: null }],
    ["slots:null", { success: true, data: { slots: null }, error: null }],
    ["slots non-array", { success: true, data: { slots: {} }, error: null }],
    ["malformed slot item", { success: true, data: { slots: [{ time: "10:00" }] }, error: null }],
  ])("shows a normalized error for %s", async (_case, body) => {
    pickupResponder = () => Promise.resolve(jsonResponse(200, body));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
  });

  it("shows a normalized error on network rejection", async () => {
    pickupResponder = () => Promise.reject(new TypeError("Failed to fetch"));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
  });

  it("exposes a manual retry that refetches and can succeed", async () => {
    let calls = 0;
    pickupResponder = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? jsonResponse(500, { success: false, data: null, error: { code: "X", message: "boom" } })
          : jsonResponse(200, slotsEnvelope([SLOT])),
      );
    };

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("radio", { name: "10:00" })).toBeDefined();
    expect(pickupCallCount()).toBe(2);
  });

  it("does not auto-refetch after a failure", async () => {
    pickupResponder = () =>
      Promise.resolve(jsonResponse(500, { success: false, data: null, error: null }));

    render(<CheckoutPage />);
    openScheduleGrid();

    expect(await screen.findByText("Failed to load slots")).toBeDefined();
    await waitFor(() => expect(pickupCallCount()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pickupCallCount()).toBe(1);
  });
});
