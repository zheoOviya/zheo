import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import DineInMenuPage from "./page";
import { useDineInStore } from "@/store/dineIn";
import { useDineInSelectionStore, DINE_IN_MAX_QUANTITY } from "@/store/dineInSelection";
import { useCartStore, useAuthStore } from "@/lib/store";
import {
  openDineInSession,
  resolveDineInTable,
  fetchRestaurantMenu,
  placeDineInOrder,
  createDineInServiceRequest,
  requestDineInBill,
  type MenuItem,
  type DineInOrderDTO,
  type DineInServiceRequestDTO,
  type DineInBillDTO,
  type DiningSessionDTO,
} from "@/lib/api";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    resolveDineInTable: vi.fn(),
    openDineInSession: vi.fn(),
    fetchRestaurantMenu: vi.fn(),
    placeDineInOrder: vi.fn(),
    createDineInServiceRequest: vi.fn(),
    requestDineInBill: vi.fn(),
  };
});

const CONTEXT = {
  sessionId: "s1",
  restaurant: { id: "r1", name: "SnakShack" },
  table: { id: "t1", label: "Table 12" },
  sessionStatus: "OPEN",
} as const;

const ITEM: MenuItem = {
  id: "m-1",
  restaurant_id: "r1",
  name: "Veg Bowl",
  price: 220,
  dietary_tags: { VEG: true },
  customizations: [],
  is_available: true,
  spice_level: 2,
  image_url: null,
};

const ORDER: DineInOrderDTO = {
  id: "o-1",
  session_id: "s1",
  restaurant_id: "r1",
  placed_by: "u1",
  status: "PLACED",
  total_amount: 236,
  notes: null,
  served_at: null,
  cancelled_at: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const SERVICE_REQUEST: DineInServiceRequestDTO = {
  id: "sr-1",
  session_id: "s1",
  restaurant_id: "r1",
  requested_by: "u1",
  request_type: "WATER",
  status: "PENDING",
  note: null,
  acknowledged_by: null,
  acknowledged_at: null,
  completed_by: null,
  completed_at: null,
  cancelled_by: null,
  cancelled_at: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const BILL_SESSION: DiningSessionDTO = {
  id: "s1",
  restaurant_id: "r1",
  table_id: "t1",
  owner_user_id: "u1",
  status: "BILL_REQUESTED",
  bill_requested_at: "2026-08-30T00:00:00.000Z",
  payment_pending_at: null,
  closed_at: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const BILL: DineInBillDTO = {
  id: "bill-1",
  session_id: "s1",
  restaurant_id: "r1",
  food_subtotal: 1000,
  packaging_fee: 0,
  gst_food: 50,
  gst_packaging: 0,
  total_amount: 1050,
  frozen_at: "2026-08-30T00:00:00.000Z",
  created_at: "2026-08-30T00:00:00.000Z",
};

const BRING_BILL: DineInServiceRequestDTO = {
  id: "sr-bill-1",
  session_id: "s1",
  restaurant_id: "r1",
  requested_by: "u1",
  request_type: "BRING_BILL",
  status: "PENDING",
  note: null,
  acknowledged_by: null,
  acknowledged_at: null,
  completed_by: null,
  completed_at: null,
  cancelled_by: null,
  cancelled_at: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

function billResult(
  sessionOverrides: Partial<typeof BILL_SESSION> = {},
  billOverrides: Partial<typeof BILL> = {},
) {
  return {
    session: { ...BILL_SESSION, ...sessionOverrides },
    bill: { ...BILL, ...billOverrides },
    bringBillRequest: { ...BRING_BILL },
  };
}

function resetStores() {
  useDineInStore.getState().clearContext();
  useDineInSelectionStore.getState().clear();
  useCartStore.setState({ items: [], restaurantId: null, restaurantName: null });
}

describe("Dine-in menu route shell / context guard (UI1-B5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([]);
  });

  it("1. empty store shows safe re-scan guidance linking to /dine-in", () => {
    render(<DineInMenuPage />);

    expect(
      screen.getByText(
        "Your dine-in session isn't available on this device page. Scan the table QR again.",
      ),
    ).toBeTruthy();

    const link = screen.getByRole("link", { name: /Scan table QR again/ });
    expect(link.getAttribute("href")).toBe("/dine-in");
  });

  it("2. empty store renders no fake menu/session data and never fetches", () => {
    render(<DineInMenuPage />);

    expect(screen.queryByText("SnakShack")).toBeNull();
    expect(screen.queryByText("Table 12")).toBeNull();
    expect(screen.queryByText("Session ready")).toBeNull();
    expect(screen.queryByText("Dine-In Menu")).toBeNull();
    expect(fetchRestaurantMenu).not.toHaveBeenCalled();
  });

  it("3. populated store renders the restaurant name", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    render(<DineInMenuPage />);

    expect(screen.getAllByText("SnakShack").length).toBeGreaterThan(0);
    expect(screen.getByText("Dine-In Menu")).toBeTruthy();
  });

  it("4. populated store renders the table label", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    render(<DineInMenuPage />);

    expect(screen.getByText("Table 12")).toBeTruthy();
  });

  it("5. populated store never renders ids, raw status, or a token", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    const { container } = render(<DineInMenuPage />);

    expect(container.textContent).not.toContain("s1");
    expect(container.textContent).not.toContain("r1");
    expect(container.textContent).not.toContain("t1");
    expect(container.textContent).not.toContain("OPEN");
    expect(container.textContent).not.toContain("super-secret");
  });

  it("6. rendering issues no session mutation", async () => {
    render(<DineInMenuPage />);
    expect(resolveDineInTable).not.toHaveBeenCalled();
    expect(openDineInSession).not.toHaveBeenCalled();
  });

  it("7. rendering never mutates a session", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    render(<DineInMenuPage />);
    expect(openDineInSession).not.toHaveBeenCalled();
  });
});

describe("Dine-in menu list fetch + read-only rendering (UI2-B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([]);
  });

  it("1. valid context fetches the menu with the exact restaurant id, once", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    await waitFor(() =>
      expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1),
    );
    expect(fetchRestaurantMenu).toHaveBeenCalledWith("r1");
  });

  it("2. loading shows skeleton placeholders while the header stays visible", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    let release!: (v: MenuItem[]) => void;
    vi.mocked(fetchRestaurantMenu).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const { container } = render(<DineInMenuPage />);

    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SnakShack").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".surface-card").length).toBeGreaterThan(0);

    await act(async () => {
      release([]);
    });
  });

  it("3. success renders the item name", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByText("Veg Bowl")).toBeTruthy();
  });

  it("4. success renders the formatted price", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByText("₹220.00")).toBeTruthy();
  });

  it("5. veg/non-veg marker derives from dietary_tags", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([
      { ...ITEM, name: "Chicken Roll", dietary_tags: { NON_VEG: true } },
    ] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByLabelText("NON_VEG")).toBeTruthy();
  });

  it("6. null image falls back gracefully (no img, item still renders)", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("₹220.00")).toBeTruthy();
  });

  it("7. image load failure falls back gracefully without layout collapse", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([
      { ...ITEM, image_url: "https://cdn.example.com/bowl.jpg" },
    ] as never);

    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    const img = container.querySelector("img");
    expect(img).toBeTruthy();

    fireEvent.error(img!);

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("Veg Bowl")).toBeTruthy();
    expect(screen.getByText("₹220.00")).toBeTruthy();
  });

  it("8. empty menu shows safe copy while the context header stays visible", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([]);

    render(<DineInMenuPage />);

    expect(await screen.findByText("No items on the menu right now.")).toBeTruthy();
    expect(screen.getByText("Table 12")).toBeTruthy();
  });

  it("9. fetch error shows safe copy, keeps context, hides raw error", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    const err = new Error("Internal Server Error") as Error & { status?: number };
    err.status = 500;
    vi.mocked(fetchRestaurantMenu).mockRejectedValue(err);

    render(<DineInMenuPage />);

    expect(await screen.findByText("We couldn't load the menu")).toBeTruthy();
    expect(screen.queryByText("Internal Server Error")).toBeNull();
    expect(useDineInStore.getState().context).toEqual(CONTEXT);
  });

  it("10. retry re-fetches the catalog only", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByText("We couldn't load the menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    expect(await screen.findByText("Veg Bowl")).toBeTruthy();
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(2);
    expect(openDineInSession).not.toHaveBeenCalled();
  });

  it("11. customizations are never rendered", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([
      { ...ITEM, customizations: [{ name: "Extra Cheese", price_delta: 30 }] },
    ] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByText("Veg Bowl")).toBeTruthy();
    expect(screen.queryByText("Extra Cheese")).toBeNull();
    expect(screen.queryByText("+₹30.00")).toBeNull();
  });

  it("12. Add performs only a local client mutation - no network", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    const add = await screen.findByRole("button", { name: /Add Veg Bowl/ });
    expect(add.hasAttribute("disabled")).toBe(false);

    fireEvent.click(add);

    expect(useDineInSelectionStore.getState().lines).toHaveLength(1);
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(openDineInSession).not.toHaveBeenCalled();
  });

  it("13. no category/bestseller/sold-out fabrication", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/bestseller|popular|trending|category/i);
  });

  it("14. rendering emits no order/session POST", async () => {
    useDineInStore.getState().setContext(CONTEXT);
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });
});

describe("Dine-in selection Add / stepper interaction (UI3-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    useDineInStore.getState().setContext(CONTEXT);
  });

  it("11. Add replaces the button with a quantity stepper (DOM mutation)", async () => {
    render(<DineInMenuPage />);
    const add = await screen.findByRole("button", { name: /Add Veg Bowl/ });
    expect(add.hasAttribute("disabled")).toBe(false);

    fireEvent.click(add);

    expect(screen.queryByRole("button", { name: /Add Veg Bowl/ })).toBeNull();
    expect(screen.getByLabelText("Decrease Veg Bowl")).toBeTruthy();
    expect(screen.getByLabelText("Increase Veg Bowl")).toBeTruthy();
    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("1");
  });

  it("12. decrement at qty 1 removes the line and restores Add", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));

    fireEvent.click(screen.getByLabelText("Decrease Veg Bowl"));

    expect(useDineInSelectionStore.getState().lines).toEqual([]);
    expect(screen.getByRole("button", { name: /Add Veg Bowl/ })).toBeTruthy();
    expect(screen.queryByLabelText("Veg Bowl quantity")).toBeNull();
  });

  it("13. repeated Add increments the same line and the count badge updates", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByLabelText("Increase Veg Bowl"));

    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("2");
    expect(screen.getByText("2 items selected")).toBeTruthy();
  });

  it("14. display total is shown as an Estimated total", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));

    expect(screen.getByText("Estimated total: ₹220.00")).toBeTruthy();
  });

  it("10. Increase is disabled at max quantity 50", async () => {
    const sel = useDineInSelectionStore.getState();
    sel.ensureScope(CONTEXT.sessionId);
    for (let i = 0; i < DINE_IN_MAX_QUANTITY; i++) {
      sel.add({ menuItemId: ITEM.id, name: ITEM.name, displayPrice: ITEM.price });
    }

    render(<DineInMenuPage />);

    const inc = await screen.findByLabelText("Increase Veg Bowl");
    expect(inc.hasAttribute("disabled")).toBe(true);
    expect(inc.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("50");
  });

  it("16. selection mutations issue zero network requests", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByLabelText("Increase Veg Bowl"));
    fireEvent.click(screen.getByLabelText("Decrease Veg Bowl"));

    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });

  it("17. dine-in selection leaves the pickup cart untouched", async () => {
    useCartStore.setState({
      items: [
        {
          menuItemId: "p-1",
          name: "Pickup Item",
          basePrice: 100,
          quantity: 1,
          customizations: [],
          restaurantId: "r0",
          restaurantName: "Other",
        },
      ],
      restaurantId: "r0",
      restaurantName: "Other",
    });
    const before = useCartStore.getState().items;

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByLabelText("Increase Veg Bowl"));

    expect(useCartStore.getState().items).toEqual(before);
    expect(useCartStore.getState().restaurantId).toBe("r0");
  });

  it("18. clearing the Dine-In context clears the selection", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);

    act(() => {
      useDineInStore.getState().clearContext();
    });

    expect(await screen.findByText("Dine-in session unavailable")).toBeTruthy();
    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );
    expect(useDineInSelectionStore.getState().sessionId).toBeNull();
  });

  it("19. no placeOrder / no order mutation is ever emitted", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));

    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
    expect(placeDineInOrder).not.toHaveBeenCalled();
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
  });

  it("20. existing menu load/error behavior is preserved alongside selection", async () => {
    const sel = useDineInSelectionStore.getState();
    sel.ensureScope(CONTEXT.sessionId);
    sel.add({ menuItemId: ITEM.id, name: ITEM.name, displayPrice: ITEM.price });

    vi.mocked(fetchRestaurantMenu)
      .mockReset()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([{ ...ITEM }] as never);

    render(<DineInMenuPage />);

    expect(await screen.findByText("We couldn't load the menu")).toBeTruthy();
    expect(sel.itemCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    expect(await screen.findByText("Veg Bowl")).toBeTruthy();
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(2);
  });
});

describe("Dine-in order submission + CTA (UI4-A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    pushMock.mockClear();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    vi.mocked(placeDineInOrder).mockReset();
    vi.mocked(placeDineInOrder).mockResolvedValue({ order: { ...ORDER } } as never);
    useAuthStore.setState({ accessToken: "access-tok", isAuthenticated: true });
    useDineInStore.getState().setContext(CONTEXT);
  });

  it("1. no selection renders no Place order CTA", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(screen.queryByRole("button", { name: /Place order/ })).toBeNull();
    expect(screen.queryByText(/item selected/)).toBeNull();
  });

  it("2. selection > 0 renders the sticky CTA with count + estimated total", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));

    expect(screen.getByRole("button", { name: /Place order/ })).toBeTruthy();
    expect(screen.getByText("1 item selected")).toBeTruthy();
    expect(screen.getByText("Estimated total: ₹220.00")).toBeTruthy();
  });

  it("3. Place order submits the exact session id and item lines", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByLabelText("Increase Veg Bowl"));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));
    expect(placeDineInOrder).toHaveBeenCalledWith(
      "s1",
      [{ menu_item_id: "m-1", quantity: 2 }],
      "access-tok",
    );
  });

  it("4. the request carries the Bearer access token", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));
    expect(placeDineInOrder).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "access-tok",
    );
  });

  it("5. payload contains only menu_item_id + quantity per line", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));
    const items = vi.mocked(placeDineInOrder).mock.calls[0]![1];
    expect(items).toEqual([{ menu_item_id: "m-1", quantity: 1 }]);
  });

  it("6. client sends no price/GST/total/restaurant-id/table-id/customizations/token", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));
    const [sessionId, items] = vi.mocked(placeDineInOrder).mock.calls[0]!;
    expect(sessionId).toBe("s1");
    for (const line of items) {
      expect(Object.keys(line).sort()).toEqual(["menu_item_id", "quantity"]);
    }
  });

  it("8. session-scope mismatch never POSTs and reconciles the selection", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    act(() => {
      const sel = useDineInSelectionStore.getState();
      sel.ensureScope("other-session");
      sel.add({ menuItemId: "m-x", name: "X", displayPrice: 1 });
    });

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(placeDineInOrder).not.toHaveBeenCalled();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(0);
    expect(useDineInSelectionStore.getState().sessionId).toBe("s1");
  });

  it("9. submit shows a disabled SUBMITTING CTA", async () => {
    let release!: (value: { order: DineInOrderDTO }) => void;
    const pending = new Promise<{ order: DineInOrderDTO }>((res) => {
      release = res;
    });
    vi.mocked(placeDineInOrder).mockReturnValue(pending);

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    const btn = screen.getByRole("button", { name: /Placing order/ });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      release({ order: { ...ORDER } });
    });
  });

  it("10. duplicate submit issues exactly one POST", async () => {
    let release!: (value: { order: DineInOrderDTO }) => void;
    const pending = new Promise<{ order: DineInOrderDTO }>((res) => {
      release = res;
    });
    vi.mocked(placeDineInOrder).mockReturnValue(pending);

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    const cta = screen.getByRole("button", { name: /Place order/ });
    fireEvent.click(cta);
    fireEvent.click(cta);

    expect(placeDineInOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ order: { ...ORDER } });
    });
  });

  it("11. success clears the selection only", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );
    expect(useDineInSelectionStore.getState().sessionId).toBe("s1");
  });

  it("12. success keeps the Dine-In context", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );
    expect(useDineInStore.getState().context).toEqual(CONTEXT);
  });

  it("13. success shows an Order placed confirmation", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order placed")).toBeTruthy();
  });

  it("14. failure preserves selection + context and shows a safe error", async () => {
    vi.mocked(placeDineInOrder).mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
    expect(useDineInStore.getState().context).toEqual(CONTEXT);
  });

  it("15. SESSION_CLOSED_FOR_ORDERING shows safe copy and keeps selection", async () => {
    vi.mocked(placeDineInOrder).mockRejectedValue(
      Object.assign(new Error("closed"), {
        status: 409,
        code: "SESSION_CLOSED_FOR_ORDERING",
      }),
    );

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("This dine-in session is no longer accepting orders"),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
  });

  it("16. BILL_FROZEN shows safe copy and keeps selection", async () => {
    vi.mocked(placeDineInOrder).mockRejectedValue(
      Object.assign(new Error("frozen"), { status: 409, code: "BILL_FROZEN" }),
    );

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("The bill has already been requested"),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
  });

  it("17. ITEM_NOT_FOUND surfaces Refresh menu and never auto-deletes", async () => {
    vi.mocked(placeDineInOrder).mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404, code: "ITEM_NOT_FOUND" }),
    );

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("An item is no longer available"),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Refresh menu/ }));

    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(2);
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
  });

  it("18. network/500 failure allows retry without losing selection", async () => {
    vi.mocked(placeDineInOrder)
      .mockRejectedValueOnce(Object.assign(new Error("500"), { status: 500 }))
      .mockResolvedValueOnce({ order: { ...ORDER } } as never);

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order placed")).toBeTruthy();
    expect(placeDineInOrder).toHaveBeenCalledTimes(2);
  });

  it("19. pickup cart stays untouched through place order", async () => {
    useCartStore.setState({
      items: [
        {
          menuItemId: "p-1",
          name: "Pickup Item",
          basePrice: 100,
          quantity: 1,
          customizations: [],
          restaurantId: "r0",
          restaurantName: "Other",
        },
      ],
      restaurantId: "r0",
      restaurantName: "Other",
    });
    const before = useCartStore.getState().items;

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );
    expect(useCartStore.getState().items).toEqual(before);
    expect(useCartStore.getState().restaurantId).toBe("r0");
  });

  it("20. authoritative server total is displayed, never overwritten by the estimate", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order total: ₹236.00")).toBeTruthy();
    expect(screen.queryByText(/Estimated total/)).toBeNull();
  });

  it("21. Add/stepper regression after a successful order", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );

    const add = screen.getByRole("button", { name: /Add Veg Bowl/ });
    expect(add).toBeTruthy();
    fireEvent.click(add);

    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("1");
    expect(screen.getByText("1 item selected")).toBeTruthy();
  });

  it("22. missing token falls back to refresh, then login with the menu destination, no POST", async () => {
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      refreshAccessToken: vi.fn().mockResolvedValue(false),
    });

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/login?from=%2Fdine-in%2Fmenu"),
    );
    expect(placeDineInOrder).not.toHaveBeenCalled();
  });

  it("23. stale token (401) redirects to login, no error panel", async () => {
    vi.mocked(placeDineInOrder).mockRejectedValue(
      Object.assign(new Error("unauthorized"), {
        status: 401,
        code: "UNAUTHORIZED",
      }),
    );

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/login?from=%2Fdine-in%2Fmenu"),
    );
    expect(screen.queryByText("Something went wrong. Try again.")).toBeNull();
  });
});

describe("Dine-in placed-order confirmation snapshot (UI4-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    pushMock.mockClear();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    vi.mocked(placeDineInOrder).mockReset();
    vi.mocked(placeDineInOrder).mockResolvedValue({ order: { ...ORDER } } as never);
    useAuthStore.setState({ accessToken: "access-tok", isAuthenticated: true });
    useDineInStore.getState().setContext(CONTEXT);
  });

  it("1. successful order renders Order placed confirmation", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order placed")).toBeTruthy();
  });

  it("2. authoritative server total is shown from the response", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order total: ₹236.00")).toBeTruthy();
  });

  it("3. PLACED maps to the safe label", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Status: Placed")).toBeTruthy();
  });

  it("4. other backend statuses map to fixed labels", async () => {
    const cases: Array<[string, string]> = [
      ["PREPARING", "Preparing"],
      ["READY_TO_SERVE", "Ready to serve"],
      ["SERVED", "Served"],
      ["CANCELLED", "Cancelled"],
    ];
    for (const [status, label] of cases) {
      vi.mocked(placeDineInOrder).mockReset();
      vi.mocked(placeDineInOrder).mockResolvedValue({
        order: { ...ORDER, status },
      } as never);
      const { unmount } = render(<DineInMenuPage />);
      fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
      fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
      expect(await screen.findByText(`Status: ${label}`)).toBeTruthy();
      unmount();
    }
  });

  it("5. no fake ETA or fabricated order number", async () => {
    const { container } = render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\bETA\b/i);
    expect(text).not.toContain("Order #");
    expect(text).not.toContain("o-1");
  });

  it("6. selection cleared and the menu stays usable", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );

    const add = screen.getByRole("button", { name: /Add Veg Bowl/ });
    fireEvent.click(add);
    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("1");
  });

  it("7. a second additive order can be placed", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() =>
      expect(useDineInSelectionStore.getState().itemCount()).toBe(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Order placed")).toBeTruthy();
  });

  it("8. second success replaces the latest snapshot", async () => {
    vi.mocked(placeDineInOrder)
      .mockReset()
      .mockResolvedValueOnce({ order: { ...ORDER } } as never)
      .mockResolvedValueOnce({
        order: { ...ORDER, id: "o-2", total_amount: 150 },
      } as never);

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    expect(await screen.findByText("Order total: ₹236.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order total: ₹150.00")).toBeTruthy();
    expect(screen.queryByText("Order total: ₹236.00")).toBeNull();
  });

  it("9. a failed second order does not erase the first success snapshot", async () => {
    vi.mocked(placeDineInOrder)
      .mockReset()
      .mockResolvedValueOnce({ order: { ...ORDER } } as never)
      .mockRejectedValueOnce(Object.assign(new Error("500"), { status: 500 }));

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    expect(await screen.findByText("Order total: ₹236.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(screen.getByText("Order total: ₹236.00")).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
  });

  it("10. clearing the Dine-In context clears the confirmation snapshot", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    act(() => {
      useDineInStore.getState().clearContext();
    });

    expect(await screen.findByText("Dine-in session unavailable")).toBeTruthy();
    expect(screen.queryByText("Order placed")).toBeNull();
  });

  it("11. no access token leaks into the DOM via the snapshot", async () => {
    useAuthStore.setState({
      accessToken: "super-secret-token",
      isAuthenticated: true,
    });
    const { container } = render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    expect(container.textContent).not.toContain("super-secret-token");
  });

  it("12. no extra GET or history fetch after success", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(placeDineInOrder).toHaveBeenCalledTimes(1);
    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });

  it("13. no polling after success", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    await new Promise((r) => setTimeout(r, 80));

    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(placeDineInOrder).toHaveBeenCalledTimes(1);
  });

  it("14. pickup cart stays untouched through the confirmation", async () => {
    useCartStore.setState({
      items: [
        {
          menuItemId: "p-1",
          name: "Pickup Item",
          basePrice: 100,
          quantity: 1,
          customizations: [],
          restaurantId: "r0",
          restaurantName: "Other",
        },
      ],
      restaurantId: "r0",
      restaurantName: "Other",
    });
    const before = useCartStore.getState().items;

    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    expect(useCartStore.getState().items).toEqual(before);
    expect(useCartStore.getState().restaurantId).toBe("r0");
  });

  it("15. existing UI4-A placeOrder contract is preserved", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await waitFor(() => expect(placeDineInOrder).toHaveBeenCalledTimes(1));

    expect(placeDineInOrder).toHaveBeenCalledWith(
      "s1",
      [{ menu_item_id: "m-1", quantity: 1 }],
      "access-tok",
    );
  });
});

describe("Dine-in service request panel + create flow (UI5-B)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    pushMock.mockClear();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    vi.mocked(createDineInServiceRequest).mockReset();
    vi.mocked(createDineInServiceRequest).mockResolvedValue({
      request: { ...SERVICE_REQUEST },
    } as never);
    useAuthStore.setState({ accessToken: "access-tok", isAuthenticated: true });
    useDineInStore.getState().setContext(CONTEXT);
  });

  it("1. Need something? opens the request panel", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    expect(
      screen.getByRole("dialog", { name: "Request something" }),
    ).toBeTruthy();
  });

  it("2. the panel exposes exactly 7 request actions", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    const actions = [
      "Water",
      "Extra plate",
      "Cutlery",
      "Tissue",
      "Clean table",
      "Call staff",
      "Other",
    ];
    for (const label of actions) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeTruthy();
    }
  });

  it("3. BRING_BILL is absent from the panel", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    expect(
      screen.queryByRole("button", { name: /Bring bill/i }),
    ).toBeNull();
    expect(screen.queryByText(/Bring the bill/i)).toBeNull();
  });

  it("4. Water maps to WATER", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    expect(createDineInServiceRequest).toHaveBeenCalledWith(
      "s1",
      "WATER",
      undefined,
      "access-tok",
    );
  });

  it("5. Call staff maps to CALL_STAFF", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Call staff" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    expect(createDineInServiceRequest).toHaveBeenCalledWith(
      "s1",
      "CALL_STAFF",
      undefined,
      "access-tok",
    );
  });

  it("6. selecting OTHER reveals the note input", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    expect(screen.queryByLabelText("What do you need?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Other" }));

    expect(screen.getByLabelText("What do you need?")).toBeTruthy();
  });

  it("7. blank OTHER note is blocked before any POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(
      await screen.findByText("Please add a note for your request."),
    ).toBeTruthy();
    expect(createDineInServiceRequest).not.toHaveBeenCalled();
  });

  it("8. OTHER note over 500 chars is blocked before any POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText("What do you need?"), {
      target: { value: "x".repeat(501) },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(
      await screen.findByText(
        "Please keep your note to 500 characters or fewer.",
      ),
    ).toBeTruthy();
    expect(createDineInServiceRequest).not.toHaveBeenCalled();
  });

  it("9. OTHER note is trimmed before POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.change(screen.getByLabelText("What do you need?"), {
      target: { value: "  Need waiter  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    expect(createDineInServiceRequest).toHaveBeenCalledWith(
      "s1",
      "OTHER",
      "Need waiter",
      "access-tok",
    );
  });

  it("10. non-OTHER requests omit the note entirely", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cutlery" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    const [, requestType, note] = vi.mocked(createDineInServiceRequest).mock
      .calls[0]!;
    expect(requestType).toBe("CUTLERY");
    expect(note).toBeUndefined();
  });

  it("11. the create helper targets the exact POST URL and method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      json: async () => ({
        success: true,
        data: { request: { ...SERVICE_REQUEST } },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createDineInServiceRequest: realCreate } =
      await vi.importActual<typeof import("@/lib/api")>("@/lib/api");

    await realCreate("s1", "WATER", undefined, "access-tok");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/dine-in/service-requests");
    expect(init.method).toBe("POST");
  });

  it("12. session_id comes from the active Dine-In context", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tissue" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    const [sessionId] = vi.mocked(createDineInServiceRequest).mock.calls[0]!;
    expect(sessionId).toBe("s1");
  });

  it("13. the create call carries the Bearer access token", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    const call = vi.mocked(createDineInServiceRequest).mock.calls[0]!;
    expect(call[0]).toBe("s1");
    expect(call[1]).toBe("WATER");
    expect(call[3]).toBe("access-tok");
  });

  it("14. the request body sends no token/table/restaurant ids", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    await waitFor(() =>
      expect(createDineInServiceRequest).toHaveBeenCalledTimes(1),
    );
    const [sessionId, requestType, note] = vi.mocked(
      createDineInServiceRequest,
    ).mock.calls[0]!;
    expect(sessionId).toBe("s1");
    expect(requestType).toBe("WATER");
    expect(note).toBeUndefined();
  });

  it("15. submitting shows disabled feedback on the send control", async () => {
    let release!: (value: { request: DineInServiceRequestDTO }) => void;
    const pending = new Promise<{ request: DineInServiceRequestDTO }>(
      (resolve) => {
        release = resolve;
      },
    );
    vi.mocked(createDineInServiceRequest).mockReturnValue(pending);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    const btn = screen.getByRole("button", { name: /Sending/ });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      release({ request: { ...SERVICE_REQUEST } });
    });
  });

  it("16. duplicate submit issues exactly one POST", async () => {
    let release!: (value: { request: DineInServiceRequestDTO }) => void;
    const pending = new Promise<{ request: DineInServiceRequestDTO }>(
      (resolve) => {
        release = resolve;
      },
    );
    vi.mocked(createDineInServiceRequest).mockReturnValue(pending);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    const send = screen.getByRole("button", { name: /Send request/ });
    fireEvent.click(send);
    fireEvent.click(send);

    expect(createDineInServiceRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ request: { ...SERVICE_REQUEST } });
    });
  });

  it("17. success shows a truthful Request sent confirmation", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(screen.getByText("Water")).toBeTruthy();
  });

  it("18. only the returned PENDING status is shown - no fabricated progress", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Call staff" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(screen.getByText("Status: Pending")).toBeTruthy();
    expect(
      screen.queryByText(/Acknowledged|Preparing|Completed|In progress/i),
    ).toBeNull();
    // No fabricated ETA, queue position, or staff identity is ever shown. The
    // confirmed request label ("Call staff") is fine — the forbidden surface is
    // the invented progress/ETA/identity, not the chosen action's own label.
    expect(screen.queryByText(/Estimated arrival|queue|position|ETA/i)).toBeNull();
    expect(screen.queryByText(/Staff [A-Z]|will arrive/i)).toBeNull();
  });

  it("19. SESSION_CLOSED_FOR_REQUEST shows safe terminal copy", async () => {
    vi.mocked(createDineInServiceRequest).mockRejectedValue(
      Object.assign(new Error("closed"), {
        status: 409,
        code: "SESSION_CLOSED_FOR_REQUEST",
      }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(
      await screen.findByText("This session is no longer accepting requests."),
    ).toBeTruthy();
    expect(screen.queryByText("SESSION_CLOSED_FOR_REQUEST")).toBeNull();
    expect(useDineInStore.getState().context?.sessionStatus).toBe("OPEN");
  });

  it("20. network/500 failure allows retry and a later success", async () => {
    vi.mocked(createDineInServiceRequest)
      .mockRejectedValueOnce(Object.assign(new Error("500"), { status: 500 }))
      .mockResolvedValueOnce({ request: { ...SERVICE_REQUEST } } as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(createDineInServiceRequest).toHaveBeenCalledTimes(2);
  });

  it("21. no cancel/acknowledge/complete controls are exposed", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));
    await screen.findByText("Request sent");

    expect(screen.queryByRole("button", { name: /Cancel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Acknowledge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Complete/i })).toBeNull();
  });

  it("22. success triggers no polling or extra GET", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));
    await screen.findByText("Request sent");

    await new Promise((r) => setTimeout(r, 80));

    expect(createDineInServiceRequest).toHaveBeenCalledTimes(1);
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });

  it("23. a cleared Dine-In context closes the panel and never POSTs", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));

    act(() => {
      useDineInStore.getState().clearContext();
    });

    expect(await screen.findByText("Dine-in session unavailable")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createDineInServiceRequest).not.toHaveBeenCalled();
  });

  it("24. the menu and place-order flow remain fully functional", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    expect(await screen.findByText("Order placed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(placeDineInOrder).toHaveBeenCalledTimes(1);
    expect(createDineInServiceRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Dine-in bill request + authoritative bill display (UI6-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    pushMock.mockClear();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    vi.mocked(requestDineInBill).mockReset();
    vi.mocked(requestDineInBill).mockResolvedValue(billResult() as never);
    useAuthStore.setState({ accessToken: "access-tok", isAuthenticated: true });
    useDineInStore.getState().setContext(CONTEXT);
  });

  function confirmBill() {
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));
    return dialog;
  }

  it("1. Request bill entry is present in the header/shell area, separate from Need something?", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(screen.getByRole("button", { name: /Request bill/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Need something/ })).toBeTruthy();
  });

  it("2. first tap opens the confirmation dialog, not the service panel", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));

    expect(
      screen.getByRole("dialog", { name: "Request the bill" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Request something" })).toBeNull();
  });

  it("3. the confirmation dialog explains the freeze consequence", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));

    expect(
      screen.getByText("Requesting the bill will stop new orders for this session."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Keep ordering/ }),
    ).toBeTruthy();
  });

  it("4. opening the dialog issues no POST of any kind", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));

    expect(requestDineInBill).not.toHaveBeenCalled();
    expect(createDineInServiceRequest).not.toHaveBeenCalled();
    expect(placeDineInOrder).not.toHaveBeenCalled();
  });

  it("5. Keep ordering closes the dialog without any POST and ordering stays usable", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    fireEvent.click(screen.getByRole("button", { name: /Keep ordering/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestDineInBill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    expect(screen.getByLabelText("Veg Bowl quantity").textContent).toBe("1");
  });

  it("6. closing via the X button issues no POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("7. confirm submits the exact session id and bearer token", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    await waitFor(() => expect(requestDineInBill).toHaveBeenCalledTimes(1));
    expect(requestDineInBill).toHaveBeenCalledWith("s1", "access-tok");
  });

  it("8. duplicate confirm issues exactly one POST", async () => {
    let release!: (value: ReturnType<typeof billResult>) => void;
    const pending = new Promise<ReturnType<typeof billResult>>((resolve) => {
      release = resolve;
    });
    vi.mocked(requestDineInBill).mockReturnValue(pending as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    const confirm = within(dialog).getByRole("button", { name: "Request bill" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(requestDineInBill).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(billResult());
    });
  });

  it("9. while submitting the confirm control shows disabled feedback", async () => {
    let release!: (value: ReturnType<typeof billResult>) => void;
    const pending = new Promise<ReturnType<typeof billResult>>((resolve) => {
      release = resolve;
    });
    vi.mocked(requestDineInBill).mockReturnValue(pending as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));

    const btn = within(dialog).getByRole("button", { name: /Requesting bill/ });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      release(billResult());
    });
  });

  it("10. success renders Bill requested and the authoritative breakdown", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(await screen.findByText("Bill requested")).toBeTruthy();
    expect(screen.getByText("Food subtotal")).toBeTruthy();
    expect(screen.getByText("₹1,000.00")).toBeTruthy();
    expect(screen.getByText("GST")).toBeTruthy();
    expect(screen.getByText("₹50.00")).toBeTruthy();
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("₹1,050.00")).toBeTruthy();
  });

  it("11. zero packaging / packaging GST rows are omitted", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(screen.queryByText("Packaging")).toBeNull();
    expect(screen.queryByText("Packaging GST")).toBeNull();
  });

  it("12. packaging rows appear when packaging_fee / gst_packaging are non-zero", async () => {
    vi.mocked(requestDineInBill).mockResolvedValue(
      billResult(
        {},
        {
          packaging_fee: 40,
          gst_packaging: 7.2,
          total_amount: 1097.2,
        },
      ) as never,
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(screen.getByText("Packaging")).toBeTruthy();
    expect(screen.getByText("₹40.00")).toBeTruthy();
    expect(screen.getByText("Packaging GST")).toBeTruthy();
    expect(screen.getByText("₹7.20")).toBeTruthy();
    expect(screen.getByText("₹1,097.20")).toBeTruthy();
  });

  it("13. after success the menu stays readable but Add is gone", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(screen.queryByRole("button", { name: /Add Veg Bowl/ })).toBeNull();
    expect(screen.getByText("Veg Bowl")).toBeTruthy();
    expect(screen.getByText("Table 12")).toBeTruthy();
  });

  it("14. after success the Place order CTA is absent", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    expect(screen.getByRole("button", { name: /Place order/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(screen.queryByRole("button", { name: /Place order/ })).toBeNull();
  });

  it("15. success clears the unsubmitted selection but keeps the session scope", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByLabelText("Increase Veg Bowl"));
    expect(useDineInSelectionStore.getState().itemCount()).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(useDineInSelectionStore.getState().itemCount()).toBe(0);
    expect(useDineInSelectionStore.getState().sessionId).toBe("s1");
  });

  it("16. the cached Dine-In sessionStatus is never overwritten by the bill response", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(useDineInStore.getState().context?.sessionStatus).toBe("OPEN");
  });

  it("17. network failure preserves selection, no freeze, no bill card", async () => {
    vi.mocked(requestDineInBill).mockRejectedValue(
      Object.assign(new Error("500"), { status: 500 }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(useDineInSelectionStore.getState().itemCount()).toBe(1);
    expect(screen.queryByText("Bill requested")).toBeNull();
    // No freeze: the preserved selection still shows the stepper and the
    // Place order CTA remains actionable.
    expect(screen.getByLabelText("Decrease Veg Bowl")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Place order/ })).toBeTruthy();
  });

  it("18. SESSION_NOT_FOUND shows re-scan safe copy", async () => {
    vi.mocked(requestDineInBill).mockRejectedValue(
      Object.assign(new Error("gone"), {
        status: 404,
        code: "SESSION_NOT_FOUND",
      }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(
      await screen.findByText(
        "We couldn't find your session. Scan the table QR again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("SESSION_NOT_FOUND")).toBeNull();
  });

  it("19. SESSION_NOT_BILLABLE shows safe copy", async () => {
    vi.mocked(requestDineInBill).mockRejectedValue(
      Object.assign(new Error("not billable"), {
        status: 400,
        code: "SESSION_NOT_BILLABLE",
      }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(
      await screen.findByText(
        "A bill can't be requested for this session right now.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("SESSION_NOT_BILLABLE")).toBeNull();
  });

  it("20. BILL_INVARIANT_VIOLATION shows generic safe copy", async () => {
    vi.mocked(requestDineInBill).mockRejectedValue(
      Object.assign(new Error("invariant"), {
        status: 500,
        code: "BILL_INVARIANT_VIOLATION",
      }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(screen.queryByText("BILL_INVARIANT_VIOLATION")).toBeNull();
  });

  it("21. a network failure allows retry which re-POSTs and succeeds", async () => {
    vi.mocked(requestDineInBill)
      .mockRejectedValueOnce(Object.assign(new Error("500"), { status: 500 }))
      .mockResolvedValueOnce(billResult() as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));

    expect(await screen.findByText("Bill requested")).toBeTruthy();
    expect(requestDineInBill).toHaveBeenCalledTimes(2);
  });

  it("22. a repeated bill request returns the existing bill and never duplicates the card", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");
    expect(screen.getAllByText("Bill requested")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await waitFor(() => expect(requestDineInBill).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText("Bill requested")).toHaveLength(1);
    expect(screen.getByText("₹1,050.00")).toBeTruthy();
  });

  it("23. requesting the bill never issues a generic service-request or order POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    expect(createDineInServiceRequest).not.toHaveBeenCalled();
    expect(placeDineInOrder).not.toHaveBeenCalled();
  });

  it("24. the bill flow never surfaces payment UI or Paid copy", async () => {
    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Pay now/i);
    expect(text).not.toContain("Paid");
  });

  it("25. bill/session ids, timestamps and bringBillRequest internals never reach the DOM", async () => {
    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    const text = container.textContent ?? "";
    expect(text).not.toContain("bill-1");
    expect(text).not.toContain("sr-bill-1");
    expect(text).not.toContain("s1");
    expect(text).not.toContain("r1");
    expect(text).not.toContain("2026-08-30T00:00:00.000Z");
  });

  it("26. success triggers no polling or extra GET", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    await new Promise((r) => setTimeout(r, 80));

    expect(requestDineInBill).toHaveBeenCalledTimes(1);
    expect(fetchRestaurantMenu).toHaveBeenCalledTimes(1);
    expect(openDineInSession).not.toHaveBeenCalled();
    expect(resolveDineInTable).not.toHaveBeenCalled();
  });

  it("27. PAYMENT_PENDING response renders a neutral Bill card with no payment behavior", async () => {
    vi.mocked(requestDineInBill).mockResolvedValue(
      billResult({
        status: "PAYMENT_PENDING",
        payment_pending_at: "2026-08-30T00:00:00.000Z",
      }) as never,
    );

    const { container } = render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(await screen.findByText("Bill")).toBeTruthy();
    expect(screen.queryByText("Bill requested")).toBeNull();
    expect(screen.getByText("₹1,050.00")).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Pay now|Paid/i);
  });

  it("28. an unexpected session status fails safe - no freeze, no payment interpretation", async () => {
    vi.mocked(requestDineInBill).mockResolvedValue(
      billResult({ status: "OPEN" }) as never,
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    expect(
      await screen.findByText("Something went wrong. Try again."),
    ).toBeTruthy();
    expect(screen.queryByText("Bill requested")).toBeNull();
    expect(screen.getByRole("button", { name: /Add Veg Bowl/ })).toBeTruthy();
  });

  it("29. missing token falls back to refresh then login with the menu destination, no POST", async () => {
    useAuthStore.setState({
      accessToken: null,
      isAuthenticated: false,
      refreshAccessToken: vi.fn().mockResolvedValue(false),
    });

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/login?from=%2Fdine-in%2Fmenu"),
    );
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("30. stale token (401) redirects to login without an error panel", async () => {
    vi.mocked(requestDineInBill).mockRejectedValue(
      Object.assign(new Error("unauthorized"), {
        status: 401,
        code: "UNAUTHORIZED",
      }),
    );

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/login?from=%2Fdine-in%2Fmenu"),
    );
    expect(screen.queryByText("Something went wrong. Try again.")).toBeNull();
  });

  it("31. a cleared Dine-In context closes the dialog and never POSTs", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    expect(screen.getByRole("dialog", { name: "Request the bill" })).toBeTruthy();

    act(() => {
      useDineInStore.getState().clearContext();
    });

    expect(await screen.findByText("Dine-in session unavailable")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("32. service requests still work alongside the bill entry", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(createDineInServiceRequest).toHaveBeenCalledTimes(1);
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("33. the normal place-order flow works before a bill is requested", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));

    expect(await screen.findByText("Order placed")).toBeTruthy();
    expect(placeDineInOrder).toHaveBeenCalledTimes(1);
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("34. a stale selection re-inserted after the freeze is not actionable", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    const sel = useDineInSelectionStore.getState();
    sel.ensureScope("s1");
    sel.add({ menuItemId: ITEM.id, name: ITEM.name, displayPrice: ITEM.price });

    expect(screen.queryByRole("button", { name: /Place order/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add Veg Bowl/ })).toBeNull();
  });

  it("35. switching to a new session resets the bill and unfreezes ordering", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    confirmBill();
    await screen.findByText("Bill requested");

    act(() => {
      useDineInStore.getState().setContext({
        sessionId: "s2",
        restaurant: { id: "r2", name: "SnakShack 2" },
        table: { id: "t2", label: "Table 3" },
        sessionStatus: "OPEN",
      });
    });

    await waitFor(() => expect(screen.queryByText("Bill requested")).toBeNull());
    expect(screen.getByRole("button", { name: /Add Veg Bowl/ })).toBeTruthy();
  });
});

describe("Dine-in menu bottom spacer + dialog accessibility repairs (UI7-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    pushMock.mockClear();
    vi.mocked(fetchRestaurantMenu).mockReset();
    vi.mocked(fetchRestaurantMenu).mockResolvedValue([{ ...ITEM }] as never);
    vi.mocked(placeDineInOrder).mockReset();
    vi.mocked(placeDineInOrder).mockResolvedValue({ order: { ...ORDER } } as never);
    vi.mocked(createDineInServiceRequest).mockReset();
    vi.mocked(createDineInServiceRequest).mockResolvedValue({
      request: { ...SERVICE_REQUEST },
    } as never);
    vi.mocked(requestDineInBill).mockReset();
    vi.mocked(requestDineInBill).mockResolvedValue(billResult() as never);
    useAuthStore.setState({ accessToken: "access-tok", isAuthenticated: true });
    useDineInStore.getState().setContext(CONTEXT);
  });

  // --- Repair A: the fixed order bar must never occlude the last menu row ---

  it("1. no selection renders no bottom spacer", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    expect(screen.queryByTestId("dine-in-menu-bottom-spacer")).toBeNull();
  });

  it("2. a selection renders the bottom spacer sized to the CTA footprint + safe area", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));

    const spacer = screen.getByTestId("dine-in-menu-bottom-spacer");
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
    const cls = spacer.getAttribute("class") ?? "";
    expect(cls).toMatch(/calc\(92px/);
    expect(cls).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  it("3. the spacer disappears once a successful order clears the selection", async () => {
    render(<DineInMenuPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Veg Bowl/ }));
    expect(screen.getByTestId("dine-in-menu-bottom-spacer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");

    expect(screen.queryByTestId("dine-in-menu-bottom-spacer")).toBeNull();
  });

  it("4. the spacer is absent while ordering is frozen by a requested bill", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));
    await screen.findByText("Bill requested");

    expect(screen.queryByTestId("dine-in-menu-bottom-spacer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Place order/ })).toBeNull();
  });

  // --- Repair B: viewport-constrained dialogs with internal scroll ---

  it("5. the service dialog is viewport-constrained with internal scroll", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    const dialog = screen.getByRole("dialog", { name: "Request something" });
    expect(dialog.className).toMatch(/max-h-\[calc\(100dvh/);
    expect(dialog.className).toMatch(/overflow-y-auto/);
  });

  it("6. the bill confirmation dialog is viewport-constrained with internal scroll", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));

    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    expect(dialog.className).toMatch(/max-h-\[calc\(100dvh/);
    expect(dialog.className).toMatch(/overflow-y-auto/);
  });

  // --- Repair C: initial focus, focus restore, Escape, body scroll lock ---

  it("7. opening the service dialog moves focus inside the dialog", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    const dialog = screen.getByRole("dialog", { name: "Request something" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("8. opening the bill dialog moves focus inside the dialog", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));

    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("9. closing the service dialog restores focus to the trigger", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    const trigger = screen.getByRole("button", { name: /Need something/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));

    expect(document.activeElement).toBe(trigger);
  });

  it("10. closing the bill dialog restores focus to the trigger", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    const trigger = screen.getByRole("button", { name: /Request bill/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /Close/ }));

    expect(document.activeElement).toBe(trigger);
  });

  it("11. Escape closes the service dialog", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    expect(screen.getByRole("dialog", { name: "Request something" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("12. Escape closes the bill confirmation dialog without a POST", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    expect(screen.getByRole("dialog", { name: "Request the bill" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(requestDineInBill).not.toHaveBeenCalled();
  });

  it("13. Escape does not close the bill dialog while submitting", async () => {
    let release!: (value: ReturnType<typeof billResult>) => void;
    const pending = new Promise<ReturnType<typeof billResult>>((resolve) => {
      release = resolve;
    });
    vi.mocked(requestDineInBill).mockReturnValue(pending as never);

    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));
    expect(within(dialog).getByRole("button", { name: /Requesting bill/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Request the bill" })).toBeTruthy();

    await act(async () => {
      release(billResult());
    });
  });

  it("14. body scroll is locked while the service dialog is open and released after close", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(document.body.style.overflow).toBe("");
  });

  it("15. body scroll is locked while the bill dialog is open and released after close", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    expect(document.body.style.overflow).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: /Keep ordering/ }));
    expect(document.body.style.overflow).toBe("");
  });

  it("16. Tab cycling is contained within the service dialog", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));

    const dialog = screen.getByRole("dialog", { name: "Request something" });
    const enabled = within(dialog)
      .getAllByRole("button")
      .filter((b) => !(b as HTMLButtonElement).disabled);
    const first = enabled[0]!;
    const last = enabled[enabled.length - 1]!;

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("17. the ordering, service-request and bill flows still work after the repairs", async () => {
    render(<DineInMenuPage />);
    await screen.findByText("Veg Bowl");

    // ordering with spacer present -> cleared after success
    fireEvent.click(screen.getByRole("button", { name: /Add Veg Bowl/ }));
    expect(screen.getByTestId("dine-in-menu-bottom-spacer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed");
    expect(screen.queryByTestId("dine-in-menu-bottom-spacer")).toBeNull();

    // service request still works
    fireEvent.click(screen.getByRole("button", { name: /Need something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Water" }));
    fireEvent.click(screen.getByRole("button", { name: /Send request/ }));
    expect(await screen.findByText("Request sent")).toBeTruthy();

    // bill flow still works
    fireEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    const dialog = screen.getByRole("dialog", { name: "Request the bill" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Request bill" }));
    await screen.findByText("Bill requested");

    expect(placeDineInOrder).toHaveBeenCalledTimes(1);
    expect(createDineInServiceRequest).toHaveBeenCalledTimes(1);
    expect(requestDineInBill).toHaveBeenCalledTimes(1);
  });
});
