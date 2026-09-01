import { describe, expect, it, vi } from "vitest";
import { AppError } from "../middleware/envelope";
import {
  DINE_IN_ADVANCE_TARGETS,
  DineInOrderService,
  type AdvanceOrderInput,
  type AdvanceOrderResult,
  type CancelOrderInput,
  type CancelOrderResult,
  type DineInOrderAdvanceTarget,
  type PlaceOrderInput,
  type PlaceOrderLineInput,
  type ValidatedPlaceOrderLine,
} from "./dineInOrder";
import { DiningSessionService, type RequestBillInput } from "./dineInSession";
import type {
  MutationOutcome,
  RequestBillResult,
  DineInEventFact,
} from "./dineInSession";
import type {
  CreateDineInOrderInput,
  DineInOrderDTO,
  DineInOrderItemDTO,
  DineInOrderRepository,
  DineInOrderWithItemsDTO,
  DineInTransactionPort,
  DineInTransactionRepos,
  DiningSessionDTO,
  ServiceRequestDTO,
  SessionBillDTO,
  TransactionalDiningSessionRepository,
  TransitionResult,
} from "../repositories/dineInContracts";
import type { CatalogRepository, MenuItemDTO } from "../repositories/catalogRepository";
import type { DiningSessionStatus, DineInOrderStatus } from "@snakzap/types";
import { calculateOrderPricing, type OrderPricingDraft } from "./dineInOrderPricing";
import type { PlaceOrderResult } from "./dineInOrder";

// D2.5D1 skeleton tests + D2.5D2 placeOrder validation/read shell tests.
// No D3+ behavioral tests (pricing/persistence are future checkpoints).

function makeSession(
  status: DiningSessionStatus,
  overrides: Partial<DiningSessionDTO> = {},
): DiningSessionDTO {
  return {
    id: "session-1",
    restaurant_id: "restaurant-1",
    table_id: "table-1",
    owner_user_id: "user-1",
    status,
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeMenuItem(overrides: Partial<MenuItemDTO> = {}): MenuItemDTO {
  return {
    id: "item-1",
    restaurant_id: "restaurant-1",
    name: "Paneer Tikka",
    price: 100,
    description: null,
    dietary_tags: {},
    customizations: [],
    image_url: null,
    pos_item_id: null,
    is_available: true,
    spice_level: 3,
    ...overrides,
  };
}

function makeOrder(): DineInOrderDTO {
  return {
    id: "order-1",
    session_id: "session-1",
    restaurant_id: "restaurant-1",
    placed_by: "user-1",
    status: "PLACED",
    total_amount: 0,
    notes: null,
    served_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeOrderWithItems(
  overrides: Partial<DineInOrderWithItemsDTO> = {},
  items: DineInOrderItemDTO[] = [],
): DineInOrderWithItemsDTO {
  return { ...makeOrder(), items, ...overrides };
}

// D8.1 default sibling fixture: a remaining non-CANCELLED order. Pre-D8.1
// cancel tests build ACTIVE-session success scenarios and must stay
// NON-final so the D8.2 guard does not fire for them.
const remainingSibling = makeOrderWithItems({ id: "order-2", status: "PLACED" });

function makeFakeTxPort(session: DiningSessionDTO | null) {
  const lockById = vi.fn(async () => session);
  const sessionCreate = vi.fn(async () => makeSession("OPEN"));
  const sessionTransition = vi.fn(
    async (
      _sessionId: string,
      _from: DiningSessionStatus,
      _to: DiningSessionStatus,
    ): Promise<TransitionResult<DiningSessionDTO, DiningSessionStatus>> => ({
      kind: "NOT_FOUND",
    }),
  );
  const createdOrders: DineInOrderWithItemsDTO[] = [];
  const orderCreate = vi.fn(async (input: CreateDineInOrderInput) => {
    const order = makeOrderWithItems(
      {
        id: "order-1",
        session_id: input.session_id,
        restaurant_id: input.restaurant_id,
        placed_by: input.placed_by,
        total_amount: input.total_amount,
        notes: input.notes ?? null,
      },
      input.items.map((item, index) => ({
        id: `oi-${index}`,
        dine_in_order_id: "order-1",
        restaurant_id: input.restaurant_id,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: item.base_price,
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: item.customization_total,
        item_subtotal: item.item_subtotal,
        created_at: "2026-08-24T00:00:00.000Z",
      })),
    );
    createdOrders.push(order);
    return order;
  });
  const orderGetBySessionWithItems = vi.fn(async (sessionId: string) =>
    createdOrders.filter((o) => o.session_id === sessionId),
  );
  const orderGetById = vi.fn(async () => null as DineInOrderDTO | null);
  const orderLockById = vi.fn(async () => null as DineInOrderDTO | null);
  const orderTransition = vi.fn(
    async (
      _orderId: string,
      _from: DineInOrderStatus,
      _to: DineInOrderStatus,
      _metadata?: { cancelled_by?: string; cancelled_at?: string; served_at?: string },
    ): Promise<TransitionResult<DineInOrderDTO, DineInOrderStatus>> => ({
      kind: "NOT_FOUND",
    }),
  );
  const diningSessions = {
    lockById,
    create: sessionCreate,
    transitionStatus: sessionTransition,
  } as unknown as TransactionalDiningSessionRepository;
  const dineInOrders = {
    create: orderCreate,
    getBySessionWithItems: orderGetBySessionWithItems,
    getById: orderGetById,
    lockById: orderLockById,
    transitionStatus: orderTransition,
  } as unknown as DineInOrderRepository;
  const repos = { diningSessions, dineInOrders } as unknown as DineInTransactionRepos;
  const runInTransaction = vi.fn((fn: (repos: DineInTransactionRepos) => Promise<unknown>) =>
    fn(repos),
  );
  return {
    port: { runInTransaction } as unknown as DineInTransactionPort,
    runInTransaction,
    lockById,
    sessionCreate,
    sessionTransition,
    orderCreate,
    orderGetBySessionWithItems,
    orderGetById,
    orderLockById,
    orderTransition,
  };
}

function makeFakeCatalog(items: Record<string, MenuItemDTO | null> = {}) {
  const getMenuItemById = vi.fn(async (id: string) => (id in items ? items[id] : null));
  return { catalog: { getMenuItemById } as unknown as CatalogRepository, getMenuItemById };
}

const basePlaceOrderInput: PlaceOrderInput = {
  session_id: "session-1",
  caller_user_id: "user-1",
  correlation_id: "corr-1",
  items: [{ menu_item_id: "item-1", quantity: 2 }],
};

const baseAdvanceInput: AdvanceOrderInput = {
  order_id: "order-1",
  caller_user_id: "user-1",
  correlation_id: "corr-1",
  target_status: "PREPARING",
};

const baseCancelInput: CancelOrderInput = {
  order_id: "order-1",
  caller_user_id: "user-1",
  correlation_id: "corr-1",
};

async function captureError(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected rejection");
}

describe("DineInOrderService (D2.5D1 skeleton)", () => {
  it("A. constructs with a fake DineInTransactionPort", () => {
    const svc = new DineInOrderService(makeFakeTxPort(null).port, makeFakeCatalog().catalog);
    expect(svc).toBeInstanceOf(DineInOrderService);
  });

  it("B. placeOrder input does not require caller-supplied restaurant/table/pricing facts", () => {
    expect(Object.keys(basePlaceOrderInput).sort()).toEqual(
      ["caller_user_id", "correlation_id", "items", "session_id"].sort(),
    );
    expect(Object.keys(basePlaceOrderInput.items[0] as PlaceOrderLineInput).sort()).toEqual(
      ["menu_item_id", "quantity"].sort(),
    );
    // Duplicate lines are structurally allowed (array, not keyed map).
    const dupes: PlaceOrderInput = {
      ...basePlaceOrderInput,
      items: [
        { menu_item_id: "item-1", quantity: 1 },
        { menu_item_id: "item-1", quantity: 1 },
      ],
    };
    expect(dupes.items).toHaveLength(2);

    // Type-level: authoritative restaurant_id is structurally impossible.
    // @ts-expect-error caller must not provide authoritative restaurant_id
    const badRestaurant: PlaceOrderInput = { ...basePlaceOrderInput, restaurant_id: "r-1" };
    void badRestaurant;
    // @ts-expect-error caller must not provide authoritative pricing
    const badPrice: PlaceOrderLineInput = { menu_item_id: "item-1", quantity: 2, item_subtotal: 10 };
    void badPrice;
    // @ts-expect-error caller must not provide authoritative unit price
    const badUnitPrice: PlaceOrderLineInput = { menu_item_id: "item-1", quantity: 2, unit_price: 5 };
    void badUnitPrice;
    // @ts-expect-error caller must not provide authoritative total
    const badTotal: PlaceOrderInput = { ...basePlaceOrderInput, total_amount: 105 };
    void badTotal;
  });

  it("C. advance target status surface is restricted to PREPARING/READY_TO_SERVE/SERVED", () => {
    expect(DINE_IN_ADVANCE_TARGETS).toEqual(["PREPARING", "READY_TO_SERVE", "SERVED"]);
    const ok: AdvanceOrderInput = { ...baseAdvanceInput, target_status: "READY_TO_SERVE" };
    expect(ok).toBeDefined();
    // @ts-expect-error CANCELLED is not a legal forward advance target
    const badTarget: AdvanceOrderInput = { ...baseAdvanceInput, target_status: "CANCELLED" };
    void badTarget;
    // @ts-expect-error PLACED is not a forward target from advance
    const badStart: AdvanceOrderInput = { ...baseAdvanceInput, target_status: "PLACED" };
    void badStart;
  });

  it("D. advanceOrder guards the CLOSED D-PAY boundary; cancelOrder classifies CLOSED as BILL_FROZEN", async () => {
    const fake = makeFakeTxPort(makeSession("CLOSED"));
    // All three legal forward edges are implemented (D6.4/D6.5/D6.6); the
    // remaining advance guard is the CLOSED session D-PAY-deferred boundary.
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      status: 501,
    });
    // D7.2: a PLACED order under a CLOSED session is a frozen-bill
    // cancellation (no CLOSED-specific error, no mutation).
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    try {
      await svc.cancelOrder(baseCancelInput);
      expect.unreachable("cancelOrder should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
    }
  });

  it("E. cancelOrder runs inside the transaction and returns the CAS result", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("DineInOrderService.placeOrder (D2.5D2 validation/read shell)", () => {
  it("A. session lock is the first authoritative persistence operation", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.lockById).toHaveBeenCalledWith("session-1");
    expect(fake.lockById.mock.invocationCallOrder[0]!).toBeLessThan(
      catalog.getMenuItemById.mock.invocationCallOrder[0]!,
    );
  });

  it("B. missing session -> SESSION_NOT_FOUND", async () => {
    const fake = makeFakeTxPort(null);
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
      status: 404,
    });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("C. owner mismatch -> SESSION_NOT_FOUND with no leakage", async () => {
    const missingFake = makeFakeTxPort(null);
    const missingSvc = new DineInOrderService(missingFake.port, makeFakeCatalog().catalog);
    const missingErr = await captureError(missingSvc.placeOrder(basePlaceOrderInput));

    const ownerFake = makeFakeTxPort(makeSession("OPEN", { owner_user_id: "other-user" }));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const ownerSvc = new DineInOrderService(ownerFake.port, catalog.catalog);
    const ownerErr = await captureError(ownerSvc.placeOrder(basePlaceOrderInput));

    expect(ownerErr.code).toBe("SESSION_NOT_FOUND");
    expect(ownerErr.status).toBe(404);
    // Indistinguishable from a missing session: identical message, no owner detail.
    expect(ownerErr.message).toBe(missingErr.message);
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("D. BILL_REQUESTED session -> SESSION_CLOSED_FOR_ORDERING", async () => {
    const fake = makeFakeTxPort(makeSession("BILL_REQUESTED"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_ORDERING",
      status: 409,
    });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("E. PAYMENT_PENDING session -> SESSION_CLOSED_FOR_ORDERING", async () => {
    const fake = makeFakeTxPort(makeSession("PAYMENT_PENDING"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_ORDERING",
    });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("F. CLOSED session -> SESSION_CLOSED_FOR_ORDERING", async () => {
    const fake = makeFakeTxPort(makeSession("CLOSED"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_ORDERING",
    });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("G. OPEN session passes the state gate", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
  });

  it("H. ACTIVE session passes the state gate", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
  });

  it("I. empty items -> EMPTY_ORDER", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(
      svc.placeOrder({ ...basePlaceOrderInput, items: [] }),
    ).rejects.toMatchObject({ code: "EMPTY_ORDER", status: 400 });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("J. quantity 0 -> INVALID_QUANTITY", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(
      svc.placeOrder({ ...basePlaceOrderInput, items: [{ menu_item_id: "item-1", quantity: 0 }] }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY", status: 400 });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("K. quantity 51 -> INVALID_QUANTITY", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(
      svc.placeOrder({ ...basePlaceOrderInput, items: [{ menu_item_id: "item-1", quantity: 51 }] }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
  });

  it("L. non-integer quantity -> INVALID_QUANTITY", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(
      svc.placeOrder({
        ...basePlaceOrderInput,
        items: [{ menu_item_id: "item-1", quantity: 1.5 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
  });

  it("M. customization intent -> CUSTOMIZATIONS_NOT_SUPPORTED", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(
      svc.placeOrder({
        ...basePlaceOrderInput,
        items: [{ menu_item_id: "item-1", quantity: 2, customizations: [{ name: "Extra spice" }] }],
      }),
    ).rejects.toMatchObject({ code: "CUSTOMIZATIONS_NOT_SUPPORTED", status: 400 });
    expect(catalog.getMenuItemById).not.toHaveBeenCalled();
  });

  it("N. missing menu item -> ITEM_NOT_FOUND", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": null });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "ITEM_NOT_FOUND",
      status: 404,
    });
  });

  it("O. restaurant mismatch -> ITEM_RESTAURANT_MISMATCH (400)", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN", { restaurant_id: "restaurant-1" }));
    const catalog = makeFakeCatalog({
      "item-1": makeMenuItem({ restaurant_id: "restaurant-2" }),
    });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "ITEM_RESTAURANT_MISMATCH",
      status: 400,
    });
    // Authoritative comparison: item's restaurant is read from the catalog,
    // not trusted from the caller (no restaurant_id exists on input).
    expect(fake.lockById).toHaveBeenCalledWith("session-1");
    expect(catalog.getMenuItemById).toHaveBeenCalledWith("item-1");
    // No order/session mutation occurs on the mismatch path.
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.orderCreate).not.toHaveBeenCalled();
  });

  it("P. duplicate lines preserved: each read separately, no merge", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder({
      ...basePlaceOrderInput,
      items: [
        { menu_item_id: "item-1", quantity: 1 },
        { menu_item_id: "item-1", quantity: 1 },
      ],
    });
    expect(outcome.kind).toBe("NEW_MUTATION");
    // Two identical lines => two separate authoritative reads (no dedup/merge).
    expect(catalog.getMenuItemById).toHaveBeenCalledTimes(2);
  });

  it("Q. valid authoritative reads reach the D5 production success path", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(catalog.getMenuItemById).toHaveBeenCalledWith("item-1");
  });

  it("R. validated lines carry only authoritative facts, no pricing math", () => {
    const line: ValidatedPlaceOrderLine = {
      menu_item_id: "item-1",
      quantity: 2,
      item_name: "Paneer Tikka",
      base_price: 100,
      restaurant_id: "restaurant-1",
    };
    expect(Object.keys(line).sort()).toEqual(
      ["base_price", "item_name", "menu_item_id", "quantity", "restaurant_id"].sort(),
    );
    // @ts-expect-error validated lines carry no computed item_subtotal
    const badSubtotal: ValidatedPlaceOrderLine = { ...line, item_subtotal: 200 };
    void badSubtotal;
    // @ts-expect-error validated lines carry no computed total
    const badTotal: ValidatedPlaceOrderLine = { ...line, total_amount: 210 };
    void badTotal;
  });

  it("S. ACTIVE path: no session create or transition on order success", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("T. advanceOrder guards the CLOSED D-PAY boundary; cancelOrder classifies CLOSED as BILL_FROZEN", async () => {
    const fake = makeFakeTxPort(makeSession("CLOSED"));
    // All three legal forward edges are implemented (D6.4/D6.5/D6.6); the
    // remaining advance guard is the CLOSED session D-PAY-deferred boundary.
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.lockById.mockResolvedValue(makeSession("CLOSED"));
    fake.orderLockById.mockResolvedValue(makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      status: 501,
    });
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
    // D7.2: PLACED + CLOSED is a frozen-bill cancellation, not a stub.
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
  });
});

function vl(
  menu_item_id: string,
  quantity: number,
  base_price: number,
  item_name = "Paneer Tikka",
) {
  return { menu_item_id, quantity, item_name, base_price, restaurant_id: "restaurant-1" };
}

describe("placeOrder pricing (D2.5D3 server-authoritative)", () => {
  it("A. one line: base_price 100 qty 2 -> subtotal 200 / food 200 / gst 10 / total 210", () => {
    const draft = calculateOrderPricing([vl("item-1", 2, 100)]);
    expect(draft.lines).toEqual([
      { menu_item_id: "item-1", name: "Paneer Tikka", base_price: 100, quantity: 2, item_subtotal: 200 },
    ]);
    expect(draft.food_subtotal).toBe(200);
    expect(draft.gst_food).toBe(10);
    expect(draft.total_amount).toBe(210);
  });

  it("B. multiple lines aggregate correctly", () => {
    const draft = calculateOrderPricing([vl("item-1", 2, 100), vl("item-2", 1, 150)]);
    expect(draft.lines[1]!.item_subtotal).toBe(150);
    expect(draft.food_subtotal).toBe(350);
    expect(draft.gst_food).toBe(17.5);
    expect(draft.total_amount).toBe(367.5);
  });

  it("C. duplicate lines remain separate (no merge)", () => {
    const draft = calculateOrderPricing([vl("item-1", 1, 100), vl("item-1", 1, 100)]);
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]!.item_subtotal).toBe(100);
    expect(draft.lines[1]!.item_subtotal).toBe(100);
    expect(draft.food_subtotal).toBe(200);
  });

  it("D. caller cannot override unit_price/subtotal/gst/total", () => {
    // @ts-expect-error caller cannot supply unit_price
    const badUnit: PlaceOrderLineInput = { menu_item_id: "item-1", quantity: 2, unit_price: 5 };
    void badUnit;
    // @ts-expect-error caller cannot supply item_subtotal
    const badSubtotal: PlaceOrderLineInput = { menu_item_id: "item-1", quantity: 2, item_subtotal: 10 };
    void badSubtotal;
    // @ts-expect-error caller cannot supply gst
    const badGst: PlaceOrderInput = { ...basePlaceOrderInput, gst: 5 };
    void badGst;
    // @ts-expect-error caller cannot supply total_amount
    const badTotal: PlaceOrderInput = { ...basePlaceOrderInput, total_amount: 210 };
    void badTotal;
  });

  it("E. item_subtotal uses authoritative catalog price", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem({ price: 150 }) });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder({
      ...basePlaceOrderInput,
      items: [{ menu_item_id: "item-1", quantity: 3 }],
    });
    const result = outcome.value as PlaceOrderResult;
    // 150 (catalog) * 3 = 450 — caller provided no price.
    expect(result.order.items[0]!.item_subtotal).toBe(450);
    expect(result.order.items[0]!.base_price).toBe(150);
  });

  it("F. order total includes food GST", () => {
    const draft = calculateOrderPricing([vl("item-1", 2, 100), vl("item-2", 1, 150)]);
    expect(draft.total_amount).toBe(draft.food_subtotal + draft.gst_food);
    expect(draft.total_amount).toBe(367.5);
  });

  it("G. no packaging fee", () => {
    const draft = calculateOrderPricing([vl("item-1", 1, 100)]);
    expect("packaging_fee" in draft).toBe(false);
    expect("packaging_fee" in draft.lines[0]!).toBe(false);
  });

  it("H. no commission", () => {
    const draft = calculateOrderPricing([vl("item-1", 1, 100)]);
    expect("commission" in draft).toBe(false);
  });

  it("I. no pickup pricing breakdown fields appear in the draft", () => {
    // calculatePriceBreakdown (pickup pricing.ts) is never called; the
    // neutral draft carries no pickup-specific fields (packaging etc).
    const draft = calculateOrderPricing([vl("item-1", 1, 100)]);
    expect(Object.keys(draft).sort()).toEqual(["food_subtotal", "gst_food", "lines", "total_amount"].sort());
  });

  it("J. zero-price item accepted through pricing", async () => {
    const draft = calculateOrderPricing([vl("item-free", 1, 0)]);
    expect(draft.lines[0]!.item_subtotal).toBe(0);
    expect(draft.total_amount).toBe(0);

    // Through placeOrder: a zero-price catalog item succeeds (total 0 is
    // NOT a rejection reason) and reaches the D5 success path.
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-free": makeMenuItem({ id: "item-free", price: 0 }) });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder({
      ...basePlaceOrderInput,
      items: [{ menu_item_id: "item-free", quantity: 1 }],
    });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as PlaceOrderResult).order.total_amount).toBe(0);
  });

  it("K. rounding edge case proves 2dp round-half-up", () => {
    // 25.5 * 5% = 1.275 -> rounds to 1.28 at 2dp (not 1.27).
    const draft = calculateOrderPricing([vl("item-1", 1, 25.5)]);
    expect(draft.lines[0]!.item_subtotal).toBe(25.5);
    expect(draft.gst_food).toBe(1.28);
    expect(draft.total_amount).toBe(26.78);
  });

  it("L. per-line subtotal snapshots preserved independently", () => {
    const draft = calculateOrderPricing([vl("item-1", 2, 100), vl("item-2", 3, 50)]);
    expect(draft.lines[0]!.item_subtotal).toBe(200);
    expect(draft.lines[1]!.item_subtotal).toBe(150);
    expect(draft.lines[0]!.menu_item_id).toBe("item-1");
    expect(draft.lines[1]!.menu_item_id).toBe("item-2");
  });

  it("M. valid pricing persists then returns the production success result", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    const result = outcome.value as PlaceOrderResult;
    // Authoritative persisted values present.
    expect(result.order.total_amount).toBe(210);
    expect(result.order.items[0]!.item_subtotal).toBe(200);
  });

  it("N. aggregate persistence: one order create with items in the same input", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    // One aggregate create (order + items are inside the same input) — no
    // separate item-level repository call exists.
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    const input = fake.orderCreate.mock.calls[0]![0] as CreateDineInOrderInput;
    expect(input.items).toHaveLength(1);
    expect(input.items[0]!.item_subtotal).toBe(200);
  });

  it("O. activation never creates a new session (OPEN path)", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    // The same session row is CAS-updated OPEN->ACTIVE exactly once.
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("P. D2 validation regressions remain green", async () => {
    // Empty order still rejected before pricing.
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder({ ...basePlaceOrderInput, items: [] })).rejects.toMatchObject({
      code: "EMPTY_ORDER",
    });
    await expect(
      svc.placeOrder({ ...basePlaceOrderInput, items: [{ menu_item_id: "item-1", quantity: 51 }] }),
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    // Session state gate still precedes pricing.
    const billed = makeFakeTxPort(makeSession("BILL_REQUESTED"));
    const billedSvc = new DineInOrderService(billed.port, catalog.catalog);
    await expect(billedSvc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_ORDERING",
    });
  });
});

describe("placeOrder persistence (D2.5D4 transactional aggregate)", () => {
  it("A. order created with exact authoritative snapshots inside the tx", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    const input = fake.orderCreate.mock.calls[0]![0] as CreateDineInOrderInput;
    expect(input.total_amount).toBe(210);
    expect(input.items).toEqual([
      {
        menu_item_id: "item-1",
        name: "Paneer Tikka",
        base_price: 100,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 200,
      },
    ]);
  });

  it("B. create input uses session/actor authority, not caller facts", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN", { restaurant_id: "restaurant-9" }));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({
      "item-1": makeMenuItem({ restaurant_id: "restaurant-9" }),
    });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    const input = fake.orderCreate.mock.calls[0]![0] as CreateDineInOrderInput;
    expect(input.session_id).toBe("session-1");
    expect(input.restaurant_id).toBe("restaurant-9"); // from locked session, not caller
    expect(input.placed_by).toBe("user-1"); // caller_user_id
    expect(fake.lockById).toHaveBeenCalledWith("session-1");
  });

  it("C. items are persisted as one aggregate (read-back returns them)", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    const result = outcome.value as PlaceOrderResult;
    expect(result.order.id).toBe("order-1");
    expect(result.order.status).toBe("PLACED");
    expect(result.order.total_amount).toBe(210);
    expect(result.order.items).toHaveLength(1);
    expect(result.order.items[0]!.item_subtotal).toBe(200);
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledWith("session-1");
  });

  it("D. duplicate lines persist as separate item rows", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder({
      ...basePlaceOrderInput,
      items: [
        { menu_item_id: "item-1", quantity: 1 },
        { menu_item_id: "item-1", quantity: 1 },
      ],
    });
    const result = outcome.value as PlaceOrderResult;
    expect(result.order.items).toHaveLength(2);
    expect(result.order.items[0]!.item_subtotal).toBe(100);
    expect(result.order.items[1]!.item_subtotal).toBe(100);
  });

  it("E. ACTIVE path: no session create/transition during order persistence", async () => {
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("F. checkpoint safety: OPEN order cannot succeed without OPEN->ACTIVE", async () => {
    // Required answer to "can production placeOrder succeed for an OPEN
    // session without transitioning it to ACTIVE?" must be NO. If the CAS
    // did not return UPDATED, the callback rejects (INTERNAL_ERROR) and no
    // success resolves — the default fake returns NOT_FOUND.
    const fake = makeFakeTxPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    let resolved = false;
    await svc
      .placeOrder(basePlaceOrderInput)
      .then(() => {
        resolved = true;
      })
      .catch((err: AppError) => {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.status).toBe(500);
      });
    expect(resolved).toBe(false);
    // The CAS was actually attempted with the frozen expected status/target.
    expect(fake.sessionTransition).toHaveBeenCalledWith("session-1", "OPEN", "ACTIVE");
  });

  it("G. zero-price order persists with total 0 and succeeds", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-free": makeMenuItem({ id: "item-free", price: 0 }) });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder({
      ...basePlaceOrderInput,
      items: [{ menu_item_id: "item-free", quantity: 1 }],
    });
    expect(outcome.kind).toBe("NEW_MUTATION");
    const input = fake.orderCreate.mock.calls[0]![0] as CreateDineInOrderInput;
    expect(input.total_amount).toBe(0);
    expect(input.items[0]!.item_subtotal).toBe(0);
  });

  it("H. missing read-back is a defensive internal invariant (INTERNAL_ERROR 500)", async () => {
    const session = makeSession("OPEN");
    const fake = makeFakeTxPort(session);
    fake.orderGetBySessionWithItems.mockResolvedValueOnce([]);
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    let resolved = false;
    await svc
      .placeOrder(basePlaceOrderInput)
      .then(() => {
        resolved = true;
      })
      .catch((err: AppError) => {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.status).toBe(500);
      });
    // Production must never resolve success when the invariant is breached.
    expect(resolved).toBe(false);
    // Order create happened once and read-back was actually attempted.
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledWith("session-1");
    // No session mutation, no event outcome on this failure path.
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("I. invalid input is rejected before any persistence", async () => {
    const fake = makeFakeTxPort(makeSession("BILL_REQUESTED"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "SESSION_CLOSED_FOR_ORDERING",
    });
    expect(fake.orderCreate).not.toHaveBeenCalled();

    const fake2 = makeFakeTxPort(makeSession("OPEN"));
    const svc2 = new DineInOrderService(fake2.port, makeFakeCatalog({}).catalog);
    await expect(svc2.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "ITEM_NOT_FOUND",
    });
    expect(fake2.orderCreate).not.toHaveBeenCalled();
  });
});

describe("placeOrder OPEN->ACTIVE activation (D2.5D5)", () => {
  function activatedPort(session: DiningSessionDTO) {
    const fake = makeFakeTxPort(session);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    return fake;
  }

  it("A. OPEN session: order persisted, OPEN->ACTIVE exactly once, NEW_MUTATION", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("B. ACTIVE session: order persisted, no transition call, NEW_MUTATION", async () => {
    const fake = activatedPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("C. OPEN transition expected status is OPEN", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    expect(fake.sessionTransition).toHaveBeenCalledWith("session-1", "OPEN", "ACTIVE");
  });

  it("D. OPEN transition target is ACTIVE", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    const [sessionId, from, to] = fake.sessionTransition.mock.calls[0]!;
    expect(sessionId).toBe("session-1");
    expect(from).toBe("OPEN");
    expect(to).toBe("ACTIVE");
  });

  it("E. activation happens after order create and read-back", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    const lock = fake.lockById.mock.invocationCallOrder[0]!;
    const create = fake.orderCreate.mock.invocationCallOrder[0]!;
    const readback = fake.orderGetBySessionWithItems.mock.invocationCallOrder[0]!;
    const transition = fake.sessionTransition.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(create);
    expect(create).toBeLessThan(readback);
    expect(readback).toBeLessThan(transition);
  });

  it("F. transition UPDATED result permits the success outcome", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as PlaceOrderResult).order.id).toBe("order-1");
  });

  it("G. STATE_MISMATCH -> INTERNAL_ERROR, no successful result", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "BILL_REQUESTED" });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    let resolved = false;
    await svc
      .placeOrder(basePlaceOrderInput)
      .then(() => {
        resolved = true;
      })
      .catch((err: AppError) => {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.status).toBe(500);
      });
    expect(resolved).toBe(false);
    // The order was created/read back, but activation failed -> no success.
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("H. NOT_FOUND -> INTERNAL_ERROR, no successful result", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN")); // default transition = NOT_FOUND
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    let resolved = false;
    await svc
      .placeOrder(basePlaceOrderInput)
      .then(() => {
        resolved = true;
      })
      .catch((err: AppError) => {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.status).toBe(500);
      });
    expect(resolved).toBe(false);
    expect(fake.orderCreate).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("I. order create failure -> activation never called", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.orderCreate.mockRejectedValueOnce(new AppError("ORDER_CREATE_FAILED", "boom", 500));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "ORDER_CREATE_FAILED",
    });
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("J. read-back inconsistency -> activation never called", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.orderGetBySessionWithItems.mockResolvedValueOnce([]);
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await expect(svc.placeOrder(basePlaceOrderInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("K. success result carries the exact persisted order DTO", async () => {
    const fake = activatedPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    const persisted = await fake.orderCreate.mock.results[0]!.value;
    expect((outcome.value as PlaceOrderResult).order).toEqual(persisted);
  });

  it("L. eventFacts is empty for now", async () => {
    const fake = activatedPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("M/N. no SessionActivated and no DineInOrderPlaced event facts", async () => {
    const fake = activatedPort(makeSession("ACTIVE"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.eventFacts).not.toContainEqual(
      expect.objectContaining({ kind: "SESSION_ACTIVATED" }),
    );
    expect(outcome.eventFacts).not.toContainEqual(
      expect.objectContaining({ kind: "DINE_IN_ORDER_PLACED" }),
    );
  });

  it("O. one tx callback owns lock -> create -> read-back -> activation", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    // Everything happened inside a single runInTransaction callback.
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
    const callback = fake.runInTransaction.mock.calls[0]![0];
    expect(typeof callback).toBe("function");
  });

  it("P. no nested/second transaction", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("Q. placeOrder locks the session as its first persistence op", async () => {
    const fake = activatedPort(makeSession("OPEN"));
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    await svc.placeOrder(basePlaceOrderInput);
    const lockOrder = fake.lockById.mock.invocationCallOrder[0]!;
    const createOrder = fake.orderCreate.mock.invocationCallOrder[0]!;
    const transitionOrder = fake.sessionTransition.mock.invocationCallOrder[0]!;
    // lockById is the first persistence operation of the transaction, so
    // requestBill and placeOrder share the same serialization boundary.
    expect(lockOrder).toBeLessThan(createOrder);
    expect(lockOrder).toBeLessThan(transitionOrder);
  });
});

describe("advanceOrder discovery + lock ordering (D2.5D6.1)", () => {
  function lockedAdvance(
    discovered: DineInOrderDTO | null,
    session: DiningSessionDTO | null,
    lockedOrder: DineInOrderDTO | null,
  ) {
    const fake = makeFakeTxPort(session);
    fake.orderGetById.mockResolvedValue(discovered);
    fake.orderLockById.mockResolvedValue(lockedOrder);
    return fake;
  }

  it("A. discovery missing -> ORDER_NOT_FOUND 404", async () => {
    const fake = lockedAdvance(null, makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
    // No locks attempted after a failed discovery.
    expect(fake.lockById).not.toHaveBeenCalled();
    expect(fake.orderLockById).not.toHaveBeenCalled();
  });

  it("B. discovery occurs before any lock", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    const discovery = fake.orderGetById.mock.invocationCallOrder[0]!;
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(discovery).toBeLessThan(sessionLock);
    expect(discovery).toBeLessThan(orderLock);
  });

  it("C. session lock occurs before order lock", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(sessionLock).toBeLessThan(orderLock);
  });

  it("D. locked order missing -> ORDER_NOT_FOUND 404", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), null);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
  });

  it("E. locked session missing -> INTERNAL_ERROR 500", async () => {
    const fake = lockedAdvance(makeOrder(), null, makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });

  it("F. locked order/session mismatch -> INTERNAL_ERROR 500", async () => {
    const session = makeSession("ACTIVE");
    const order = { ...makeOrder(), session_id: "session-other" };
    const fake = lockedAdvance(order, session, order);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });

  it("G. discovery status is not used for transition behavior", async () => {
    // Discovery reports PLACED while the locked (authoritative) order is
    // SERVED. Classification uses the LOCKED status: SERVED -> PREPARING is
    // invalid (409). If discovery status (PLACED -> PREPARING) were used it
    // would be a legal D6.4 candidate — so the 409 proves locked authority.
    const discovered = { ...makeOrder(), status: "PLACED" as const };
    const locked = { ...makeOrder(), status: "SERVED" as const };
    const fake = lockedAdvance(discovered, makeSession("ACTIVE"), locked);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("H. valid lock sequence reaches the implemented READY_TO_SERVE->SERVED CAS", async () => {
    const fake = lockedAdvance(
      { ...makeOrder(), status: "READY_TO_SERVE" as const },
      makeSession("ACTIVE"),
      { ...makeOrder(), status: "READY_TO_SERVE" as const },
    );
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "SERVED", served_at: "2026-08-24T10:00:00.000Z" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order.status).toBe("SERVED");
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("I. no transitionStatus call", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("J. D6.4/D6.5 no-metadata CAS edges carry no served_at and no session write", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder(baseAdvanceInput); // PLACED -> PREPARING (D6.4)
    expect(outcome.kind).toBe("NEW_MUTATION");
    // The D6.4/D6.5 CAS carries NO metadata argument (no served_at).
    expect(fake.orderTransition.mock.calls[0]!).toHaveLength(3);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.sessionCreate).not.toHaveBeenCalled();
  });

  it("K. no session mutation during the lock shell", async () => {
    const fake = lockedAdvance(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("L. cancelOrder performs the D7.3 cancellation CAS", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("M. placeOrder D2-D5 regressions remain green", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as PlaceOrderResult).order.total_amount).toBe(210);
  });
});

describe("advanceOrder session-state boundary (D2.5D6.2)", () => {
  it("A/B/C/D. OPEN/ACTIVE/BILL_REQUESTED/PAYMENT_PENDING reach the implemented CAS", async () => {
    for (const status of ["OPEN", "ACTIVE", "BILL_REQUESTED", "PAYMENT_PENDING"] as const) {
      const fake = makeFakeTxPort(makeSession(status));
      // All legal forward edges are implemented; the session-state
      // pass-through is observable via the READY_TO_SERVE -> SERVED CAS.
      fake.orderGetById.mockResolvedValue({ ...makeOrder(), status: "READY_TO_SERVE" as const });
      fake.orderLockById.mockResolvedValue({ ...makeOrder(), status: "READY_TO_SERVE" as const });
      fake.orderTransition.mockResolvedValue({
        kind: "UPDATED",
        value: { ...makeOrder(), status: "SERVED", served_at: "2026-08-24T10:00:00.000Z" },
      });
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" });
      expect(outcome.kind).toBe("NEW_MUTATION");
      // Billing states are NOT rejected with a bill-frozen taxonomy.
      expect(fake.sessionTransition).not.toHaveBeenCalled();
    }
  });

  it("E. CLOSED hits the explicit D-PAY-deferred guard", async () => {
    const fake = makeFakeTxPort(makeSession("CLOSED"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const err = await captureError(svc.advanceOrder(baseAdvanceInput));
    expect(err.code).toBe("NOT_IMPLEMENTED");
    expect(err.status).toBe(501);
    expect(err.message).toMatch(/D-PAY|deferred/i);
  });

  it("F. CLOSED causes zero order transition calls", async () => {
    const fake = makeFakeTxPort(makeSession("CLOSED"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("G/H. BILL_REQUESTED / PAYMENT_PENDING are not rejected as BILL_FROZEN", async () => {
    for (const status of ["BILL_REQUESTED", "PAYMENT_PENDING"] as const) {
      const fake = makeFakeTxPort(makeSession(status));
      fake.orderGetById.mockResolvedValue({ ...makeOrder(), status: "READY_TO_SERVE" as const });
      fake.orderLockById.mockResolvedValue({ ...makeOrder(), status: "READY_TO_SERVE" as const });
      fake.orderTransition.mockResolvedValue({
        kind: "UPDATED",
        value: { ...makeOrder(), status: "SERVED", served_at: "2026-08-24T10:00:00.000Z" },
      });
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" });
      expect(outcome.kind).toBe("NEW_MUTATION"); // CAS succeeds, not a frozen-bill rejection
    }
  });

  it("I. D6.1 discovery -> session lock -> order lock ordering unchanged", async () => {
    const fake = makeFakeTxPort(makeSession("PAYMENT_PENDING"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput).catch(() => undefined);
    const discovery = fake.orderGetById.mock.invocationCallOrder[0]!;
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(discovery).toBeLessThan(sessionLock);
    expect(sessionLock).toBeLessThan(orderLock);
  });

  it("J. session-state boundary precedes order-status classification", async () => {
    // The CLOSED capability gate fires BEFORE any order-status handling,
    // regardless of the locked order status (order classification is D6.3).
    for (const orderStatus of ["PLACED", "PREPARING", "READY_TO_SERVE", "SERVED"] as const) {
      const fake = makeFakeTxPort(makeSession("CLOSED"));
      fake.orderGetById.mockResolvedValue({ ...makeOrder(), status: orderStatus });
      fake.orderLockById.mockResolvedValue({ ...makeOrder(), status: orderStatus });
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      const err = await captureError(svc.advanceOrder(baseAdvanceInput));
      expect(err.code).toBe("NOT_IMPLEMENTED"); // CLOSED D-PAY-deferred guard
      expect(err.message).toMatch(/D-PAY|deferred/i);
      expect(fake.sessionTransition).not.toHaveBeenCalled();
    }
  });

  it("K. D6.4 no-metadata CAS path carries no served_at", async () => {
    const fake = makeFakeTxPort(makeSession("BILL_REQUESTED"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(baseAdvanceInput);
    // The D6.4 CAS fires for PLACED->PREPARING with NO metadata argument at
    // all (no served_at / cancellation / timestamps).
    const casCall = fake.orderTransition.mock.calls[0]!;
    expect(casCall[0]).toBe("order-1");
    expect(casCall[1]).toBe("PLACED");
    expect(casCall[2]).toBe("PREPARING");
    expect(casCall).toHaveLength(3);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.orderCreate).not.toHaveBeenCalled();
  });

  it("L. cancelOrder performs the D7.3 cancellation CAS", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.orderGetById.mockResolvedValue(makeOrder());
    fake.orderLockById.mockResolvedValue(makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("M. placeOrder regressions remain green", async () => {
    const fake = makeFakeTxPort(makeSession("OPEN"));
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("ACTIVE") });
    const catalog = makeFakeCatalog({ "item-1": makeMenuItem() });
    const svc = new DineInOrderService(fake.port, catalog.catalog);
    const outcome = await svc.placeOrder(basePlaceOrderInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
  });
});

describe("advanceOrder transition matrix + idempotency (D2.5D6.3)", () => {
  function matrixAdvance(orderStatus: DineInOrderDTO["status"]) {
    const order = { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A. PREPARING -> PREPARING same-target is idempotent, no CAS", async () => {
    const { fake, order } = matrixAdvance("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(order);
    expect(outcome.eventFacts).toEqual([]);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("B. READY_TO_SERVE -> READY_TO_SERVE same-target is idempotent, no CAS", async () => {
    const { fake, order } = matrixAdvance("READY_TO_SERVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(order);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("C. SERVED -> SERVED same-target is idempotent and preserves served_at", async () => {
    const served = {
      ...makeOrder(),
      status: "SERVED" as const,
      served_at: "2026-08-24T10:00:00.000Z",
    };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(served);
    fake.orderLockById.mockResolvedValue(served);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(served);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("D. PLACED -> PREPARING is a legal forward edge via the D6.4 CAS", async () => {
    const { fake } = matrixAdvance("PLACED");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderTransition).toHaveBeenCalledWith("order-1", "PLACED", "PREPARING");
  });

  it("E. PREPARING -> READY_TO_SERVE is a legal forward edge via the D6.5 CAS", async () => {
    const { fake } = matrixAdvance("PREPARING");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "READY_TO_SERVE" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderTransition).toHaveBeenCalledWith("order-1", "PREPARING", "READY_TO_SERVE");
  });

  it("F. READY_TO_SERVE -> SERVED is a legal forward edge via the D6.6 CAS", async () => {
    const { fake } = matrixAdvance("READY_TO_SERVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "SERVED", served_at: "2026-08-24T10:00:00.000Z" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "READY_TO_SERVE",
      "SERVED",
      { served_at: expect.any(String) },
    );
  });

  it("G. backward jumps are invalid 409", async () => {
    for (const [from, to] of [
      ["SERVED", "PREPARING"],
      ["SERVED", "READY_TO_SERVE"],
      ["READY_TO_SERVE", "PREPARING"],
    ] as const) {
      const { fake } = matrixAdvance(from);
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await expect(
        svc.advanceOrder({ ...baseAdvanceInput, target_status: to }),
      ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
      expect(fake.orderTransition).not.toHaveBeenCalled();
    }
  });

  it("H. skip jumps are invalid 409", async () => {
    for (const [from, to] of [
      ["PLACED", "READY_TO_SERVE"],
      ["PLACED", "SERVED"],
      ["PREPARING", "SERVED"],
    ] as const) {
      const { fake } = matrixAdvance(from);
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await expect(
        svc.advanceOrder({ ...baseAdvanceInput, target_status: to }),
      ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
      expect(fake.orderTransition).not.toHaveBeenCalled();
    }
  });

  it("I. CANCELLED cannot advance", async () => {
    for (const target of ["PREPARING", "READY_TO_SERVE", "SERVED"] as const) {
      const { fake } = matrixAdvance("CANCELLED");
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await expect(
        svc.advanceOrder({ ...baseAdvanceInput, target_status: target }),
      ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
      expect(fake.orderTransition).not.toHaveBeenCalled();
    }
  });

  it("J. locked order status is authoritative over discovery status", async () => {
    // Discovery reports PLACED but the locked (authoritative) order is
    // PREPARING; same-target PREPARING idempotency must fire, NOT the D6.4
    // PLACED -> PREPARING CAS. If discovery status were consulted this would
    // be a CAS candidate.
    const discovered = { ...makeOrder(), status: "PLACED" as const };
    const locked = { ...makeOrder(), status: "PREPARING" as const };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(discovered);
    fake.orderLockById.mockResolvedValue(locked);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(locked);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("K. invalid jumps stay 409 under billing states", async () => {
    for (const sessionStatus of ["BILL_REQUESTED", "PAYMENT_PENDING"] as const) {
      for (const [from, to] of [
        ["SERVED", "PREPARING"],
        ["SERVED", "READY_TO_SERVE"],
      ] as const) {
        const fake = makeFakeTxPort(makeSession(sessionStatus));
        fake.orderGetById.mockResolvedValue({ ...makeOrder(), status: from });
        fake.orderLockById.mockResolvedValue({ ...makeOrder(), status: from });
        const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
        await expect(
          svc.advanceOrder({ ...baseAdvanceInput, target_status: to }),
        ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
        expect(fake.orderTransition).not.toHaveBeenCalled();
      }
    }
  });

  it("L. legal edges stay legal under billing states (no BILL_FROZEN for advance)", async () => {
    for (const sessionStatus of ["BILL_REQUESTED", "PAYMENT_PENDING"] as const) {
      for (const [from, to] of [
        ["PLACED", "PREPARING"],
        ["PREPARING", "READY_TO_SERVE"],
        ["READY_TO_SERVE", "SERVED"],
      ] as const) {
        const fake = makeFakeTxPort(makeSession(sessionStatus));
        fake.orderGetById.mockResolvedValue({ ...makeOrder(), status: from });
        fake.orderLockById.mockResolvedValue({ ...makeOrder(), status: from });
        fake.orderTransition.mockResolvedValue({
          kind: "UPDATED",
          value: { ...makeOrder(), status: to },
        });
        const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
        const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: to });
        expect(outcome.kind).toBe("NEW_MUTATION");
        expect(fake.sessionTransition).not.toHaveBeenCalled();
      }
    }
  });
});

describe("advanceOrder PLACED -> PREPARING CAS (D2.5D6.4)", () => {
  function casPort(orderStatus: DineInOrderDTO["status"]) {
    const order = { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    return { fake, order };
  }

  it("A. PLACED -> PREPARING calls the order CAS exactly once", async () => {
    const { fake } = casPort("PLACED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    // No second read for convergence: discovery, session lock, order lock,
    // and the CAS each fire exactly once.
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(fake.lockById).toHaveBeenCalledTimes(1);
    expect(fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("B. exact CAS args: order.id / PLACED / PREPARING, 3-arg no metadata", async () => {
    const { fake } = casPort("PLACED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(fake.orderTransition).toHaveBeenCalledWith("order-1", "PLACED", "PREPARING");
    expect(fake.orderTransition.mock.calls[0]!).toHaveLength(3);
  });

  it("C. UPDATED -> NEW_MUTATION with the exact transition.value", async () => {
    const { fake } = casPort("PLACED");
    const updated = { ...makeOrder(), status: "PREPARING" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: updated });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(updated);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("D. NOT_FOUND -> ORDER_NOT_FOUND 404", async () => {
    const { fake } = casPort("PLACED");
    fake.orderTransition.mockResolvedValue({ kind: "NOT_FOUND" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
  });

  it("E. STATE_MISMATCH -> INVALID_DINE_IN_TRANSITION 409", async () => {
    const { fake } = casPort("PLACED");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "SERVED" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
  });

  it("F. target-current mismatch is NOT fabricated as idempotent", async () => {
    // A CAS reporting current=PREPARING (the target) is a concurrent
    // divergence, NOT an idempotent retry; same-target idempotency is
    // resolved pre-CAS from the locked order. Stays a defensive 409, no
    // convergence read.
    const { fake } = casPort("PLACED");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "PREPARING" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
  });

  it("G. same-target PREPARING is pre-CAS idempotent", async () => {
    const { fake, order } = casPort("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(order);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("H. no served_at metadata on the D6.4 CAS", async () => {
    const { fake } = casPort("PLACED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(fake.orderTransition.mock.calls[0]!).toHaveLength(3);
  });

  it("I. no session mutation", async () => {
    const { fake } = casPort("PLACED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.sessionCreate).not.toHaveBeenCalled();
  });
});

describe("advanceOrder PREPARING -> READY_TO_SERVE CAS (D2.5D6.5)", () => {
  function casPort(orderStatus: DineInOrderDTO["status"]) {
    const order = { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "READY_TO_SERVE" },
    });
    return { fake, order };
  }

  it("A. PREPARING -> READY_TO_SERVE calls the order CAS exactly once", async () => {
    const { fake } = casPort("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    // No second read for convergence: discovery, session lock, order lock,
    // and the CAS each fire exactly once.
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(fake.lockById).toHaveBeenCalledTimes(1);
    expect(fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("B. exact CAS args: order.id / PREPARING / READY_TO_SERVE, 3-arg no metadata", async () => {
    const { fake } = casPort("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "PREPARING",
      "READY_TO_SERVE",
    );
    expect(fake.orderTransition.mock.calls[0]!).toHaveLength(3);
  });

  it("C. UPDATED -> NEW_MUTATION with the exact transition.value", async () => {
    const { fake } = casPort("PREPARING");
    const updated = { ...makeOrder(), status: "READY_TO_SERVE" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: updated });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(updated);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("D. NOT_FOUND -> ORDER_NOT_FOUND 404", async () => {
    const { fake } = casPort("PREPARING");
    fake.orderTransition.mockResolvedValue({ kind: "NOT_FOUND" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "READY_TO_SERVE" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
  });

  it("E. STATE_MISMATCH -> INVALID_DINE_IN_TRANSITION 409", async () => {
    const { fake } = casPort("PREPARING");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "SERVED" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "READY_TO_SERVE" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
  });

  it("F. target-current mismatch is NOT fabricated as idempotent", async () => {
    // CAS reports current=READY_TO_SERVE (the target): a concurrent
    // divergence, not an idempotent retry. Stays a defensive 409, no
    // convergence read.
    const { fake } = casPort("PREPARING");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "READY_TO_SERVE" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "READY_TO_SERVE" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
  });

  it("G. same-target READY_TO_SERVE is pre-CAS idempotent", async () => {
    const { fake, order } = casPort("READY_TO_SERVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(order);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("H. no served_at metadata on the D6.5 CAS", async () => {
    const { fake } = casPort("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(fake.orderTransition.mock.calls[0]!).toHaveLength(3);
  });

  it("I. no session mutation", async () => {
    const { fake } = casPort("PREPARING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.sessionCreate).not.toHaveBeenCalled();
  });
});

describe("advanceOrder READY_TO_SERVE -> SERVED CAS + served_at audit (D2.5D6.6)", () => {
  function servedPort() {
    const order = { ...makeOrder(), status: "READY_TO_SERVE" as const };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "SERVED", served_at: "2026-08-24T10:00:00.000Z" },
    });
    return { fake, order };
  }
  const servedInput: AdvanceOrderInput = { ...baseAdvanceInput, target_status: "SERVED" };

  it("A. READY_TO_SERVE -> SERVED calls the order CAS exactly once", async () => {
    const { fake } = servedPort();
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(servedInput);
    // No second read for convergence: discovery, session lock, order lock,
    // and the CAS each fire exactly once.
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(fake.lockById).toHaveBeenCalledTimes(1);
    expect(fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("B. exact CAS args with { served_at } metadata", async () => {
    const { fake } = servedPort();
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(servedInput);
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "READY_TO_SERVE",
      "SERVED",
      { served_at: expect.any(String) },
    );
  });

  it("C. served_at is a single server-generated ISO timestamp", async () => {
    const { fake } = servedPort();
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(servedInput);
    const casCall = fake.orderTransition.mock.calls[0]!;
    expect(casCall).toHaveLength(4);
    const servedAt = casCall[3]!.served_at!;
    expect(new Date(servedAt).toISOString()).toBe(servedAt);
  });

  it("D. UPDATED -> NEW_MUTATION with the exact transition.value", async () => {
    const { fake } = servedPort();
    const updated = {
      ...makeOrder(),
      status: "SERVED" as const,
      served_at: "2026-08-24T10:00:00.000Z",
    };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: updated });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder(servedInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(updated);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("E. NOT_FOUND -> ORDER_NOT_FOUND 404", async () => {
    const { fake } = servedPort();
    fake.orderTransition.mockResolvedValue({ kind: "NOT_FOUND" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(servedInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
  });

  it("F. STATE_MISMATCH -> INVALID_DINE_IN_TRANSITION 409", async () => {
    const { fake } = servedPort();
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "READY_TO_SERVE" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(servedInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    expect(fake.orderGetById).toHaveBeenCalledTimes(1); // no convergence read
  });

  it("G. SERVED same-target is pre-CAS idempotent and preserves existing served_at", async () => {
    const served = {
      ...makeOrder(),
      status: "SERVED" as const,
      served_at: "2026-08-24T10:00:00.000Z",
    };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(served);
    fake.orderLockById.mockResolvedValue(served);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.advanceOrder(servedInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as AdvanceOrderResult).order).toEqual(served);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("H. no session mutation", async () => {
    const { fake } = servedPort();
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.advanceOrder(servedInput);
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.sessionCreate).not.toHaveBeenCalled();
  });

  it("I. D6.4/D6.5 edges stay 3-arg while D6.6 is the only 4-arg served_at edge", async () => {
    // PLACED -> PREPARING (D6.4)
    const d64 = makeFakeTxPort(makeSession("ACTIVE"));
    d64.orderGetById.mockResolvedValue(makeOrder());
    d64.orderLockById.mockResolvedValue(makeOrder());
    d64.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svc64 = new DineInOrderService(d64.port, makeFakeCatalog().catalog);
    await svc64.advanceOrder({ ...baseAdvanceInput, target_status: "PREPARING" });
    expect(d64.orderTransition.mock.calls[0]!).toHaveLength(3);
    // PREPARING -> READY_TO_SERVE (D6.5)
    const d65 = makeFakeTxPort(makeSession("ACTIVE"));
    d65.orderGetById.mockResolvedValue({ ...makeOrder(), status: "PREPARING" as const });
    d65.orderLockById.mockResolvedValue({ ...makeOrder(), status: "PREPARING" as const });
    d65.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "READY_TO_SERVE" },
    });
    const svc65 = new DineInOrderService(d65.port, makeFakeCatalog().catalog);
    await svc65.advanceOrder({ ...baseAdvanceInput, target_status: "READY_TO_SERVE" });
    expect(d65.orderTransition.mock.calls[0]!).toHaveLength(3);
  });
});

describe("cancelOrder discovery + lock ordering (D7.1)", () => {
  function lockedCancel(
    discovered: DineInOrderDTO | null,
    session: DiningSessionDTO | null,
    lockedOrder: DineInOrderDTO | null,
  ) {
    const fake = makeFakeTxPort(session);
    fake.orderGetById.mockResolvedValue(discovered);
    fake.orderLockById.mockResolvedValue(lockedOrder);
    return fake;
  }

  it("A. discovery missing -> ORDER_NOT_FOUND 404", async () => {
    const fake = lockedCancel(null, makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
    expect(fake.lockById).not.toHaveBeenCalled();
    expect(fake.orderLockById).not.toHaveBeenCalled();
  });

  it("B. discovery occurs before any lock", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput).catch(() => undefined);
    const discovery = fake.orderGetById.mock.invocationCallOrder[0]!;
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(discovery).toBeLessThan(sessionLock);
    expect(discovery).toBeLessThan(orderLock);
  });

  it("C. session lock occurs before order lock", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("ACTIVE"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput).catch(() => undefined);
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(sessionLock).toBeLessThan(orderLock);
  });

  it("D. locked session missing -> INTERNAL_ERROR 500", async () => {
    const fake = lockedCancel(makeOrder(), null, makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });

  it("E. locked order missing -> ORDER_NOT_FOUND 404", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("ACTIVE"), null);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
  });

  it("F. locked order/session mismatch -> INTERNAL_ERROR 500", async () => {
    const session = makeSession("ACTIVE");
    const order = { ...makeOrder(), session_id: "session-other" };
    const fake = lockedCancel(order, session, order);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });

  it("G. discovery.status is not authoritative", async () => {
    // Discovery reports a cancellable PLACED; the locked (authoritative) order
    // is READY_TO_SERVE -> ORDER_NOT_CANCELLABLE 409. If discovery.status were
    // consulted, the CAS would be attempted instead.
    const discovered = makeOrder();
    const locked = { ...makeOrder(), status: "READY_TO_SERVE" as const };
    const fake = lockedCancel(discovered, makeSession("ACTIVE"), locked);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("H. locked order/session are authoritative", async () => {
    // Discovery claims an already-CANCELLED idempotent outcome, but the locked
    // order is PLACED under an OPEN session -> the cancellation CAS proceeds
    // with the LOCKED status as expected-from (no idempotent shortcut off the
    // discovery DTO).
    const discovered = {
      ...makeOrder(),
      status: "CANCELLED" as const,
      cancelled_at: "2026-08-24T09:00:00.000Z",
      cancelled_by: "user-9",
    };
    const fake = lockedCancel(discovered, makeSession("OPEN"), makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "PLACED",
      "CANCELLED",
      expect.objectContaining({ cancelled_by: "user-1" }),
    );
  });

  it("I. exactly one runInTransaction", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("OPEN"), makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("J. no order -> session lock inversion", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("OPEN"), makeOrder());
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput).catch(() => undefined);
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(orderLock).not.toBeLessThan(sessionLock);
  });

  it("K. no session mutation", async () => {
    const fake = lockedCancel(makeOrder(), makeSession("OPEN"), makeOrder());
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.sessionCreate).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("L. no production auth/security/payment side effects", async () => {
    // A non-cancellable stage short-circuits every mutation path: no CAS, no
    // session writes, no other repository side effects.
    const locked = { ...makeOrder(), status: "READY_TO_SERVE" as const };
    const fake = lockedCancel(makeOrder(), makeSession("ACTIVE"), locked);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    expect(fake.sessionCreate).not.toHaveBeenCalled();
  });
});

describe("cancelOrder cancellation precedence (D7.2)", () => {
  const cancelledOrder = {
    ...makeOrder(),
    status: "CANCELLED" as const,
    cancelled_at: "2026-08-24T09:00:00.000Z",
    cancelled_by: "user-9",
  };

  function classify(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
    options: { discoveredStatus?: DineInOrderDTO["status"]; lockedOrder?: DineInOrderDTO } = {},
  ) {
    const order = options.lockedOrder ?? { ...makeOrder(), status: orderStatus };
    const discovered = options.discoveredStatus
      ? { ...makeOrder(), status: options.discoveredStatus }
      : order;
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(discovered);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A. CANCELLED + OPEN -> IDEMPOTENT_NO_MUTATION", async () => {
    const { fake, order } = classify("CANCELLED", "OPEN", { lockedOrder: cancelledOrder });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(order);
    expect(outcome.eventFacts).toEqual([]);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("B. CANCELLED + BILL_REQUESTED -> IDEMPOTENT_NO_MUTATION, not BILL_FROZEN", async () => {
    const { fake, order } = classify("CANCELLED", "BILL_REQUESTED", {
      lockedOrder: cancelledOrder,
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(order);
    expect(outcome.eventFacts).toEqual([]);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("C. CANCELLED + CLOSED -> IDEMPOTENT_NO_MUTATION", async () => {
    const { fake, order } = classify("CANCELLED", "CLOSED", { lockedOrder: cancelledOrder });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(order);
    expect(outcome.eventFacts).toEqual([]);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("D. READY_TO_SERVE + OPEN -> ORDER_NOT_CANCELLABLE 409", async () => {
    const { fake } = classify("READY_TO_SERVE", "OPEN");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("E. READY_TO_SERVE + BILL_REQUESTED -> ORDER_NOT_CANCELLABLE 409, wins over BILL_FROZEN", async () => {
    const { fake } = classify("READY_TO_SERVE", "BILL_REQUESTED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("F. SERVED + ACTIVE -> ORDER_NOT_CANCELLABLE 409", async () => {
    const { fake } = classify("SERVED", "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("G. SERVED + PAYMENT_PENDING -> ORDER_NOT_CANCELLABLE 409, wins over BILL_FROZEN", async () => {
    const { fake } = classify("SERVED", "PAYMENT_PENDING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("H. PLACED + BILL_REQUESTED -> BILL_FROZEN 409", async () => {
    const { fake } = classify("PLACED", "BILL_REQUESTED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("I. PREPARING + PAYMENT_PENDING -> BILL_FROZEN 409", async () => {
    const { fake } = classify("PREPARING", "PAYMENT_PENDING");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("J. PLACED + CLOSED -> BILL_FROZEN 409", async () => {
    const { fake } = classify("PLACED", "CLOSED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("K. PLACED + OPEN reaches the legal cancellation mutation", async () => {
    const { fake } = classify("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order.status).toBe("CANCELLED");
  });

  it("L. PLACED + ACTIVE is classified as a cancellation candidate", async () => {
    const { fake } = classify("PLACED", "ACTIVE");
    fake.orderTransition.mockRejectedValue(new Error("CAS-reached-sentinel"));
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const err = await captureError(svc.cancelOrder(baseCancelInput));
    expect(err.message).toBe("CAS-reached-sentinel");
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("M. PREPARING + OPEN reaches the legal cancellation mutation", async () => {
    const { fake } = classify("PREPARING", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order.status).toBe("CANCELLED");
  });

  it("N. PREPARING + ACTIVE is classified as a cancellation candidate", async () => {
    const { fake } = classify("PREPARING", "ACTIVE");
    fake.orderTransition.mockRejectedValue(new Error("CAS-reached-sentinel"));
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const err = await captureError(svc.cancelOrder(baseCancelInput));
    expect(err.message).toBe("CAS-reached-sentinel");
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("R. discovery.status differing from lockedOrder.status does not change precedence", async () => {
    // Discovery claims an idempotent CANCELLED; the locked order is PLACED under
    // OPEN -> the locked PLACED candidate path runs (CAS reached, not idempotent).
    const cancelledDiscovery = classify("PLACED", "OPEN", {
      discoveredStatus: "CANCELLED",
    });
    cancelledDiscovery.fake.orderTransition.mockRejectedValue(
      new Error("CAS-reached-sentinel"),
    );
    const svc1 = new DineInOrderService(
      cancelledDiscovery.fake.port,
      makeFakeCatalog().catalog,
    );
    const err1 = await captureError(svc1.cancelOrder(baseCancelInput));
    expect(err1.message).toBe("CAS-reached-sentinel");
    expect(cancelledDiscovery.fake.orderTransition).toHaveBeenCalledTimes(1);
    // Discovery claims a non-cancellable READY_TO_SERVE; the locked order is
    // PLACED under OPEN -> the locked PLACED candidate path still runs.
    const readyDiscovery = classify("PLACED", "OPEN", {
      discoveredStatus: "READY_TO_SERVE",
    });
    readyDiscovery.fake.orderTransition.mockRejectedValue(
      new Error("CAS-reached-sentinel"),
    );
    const svc2 = new DineInOrderService(readyDiscovery.fake.port, makeFakeCatalog().catalog);
    const err2 = await captureError(svc2.cancelOrder(baseCancelInput));
    expect(err2.message).toBe("CAS-reached-sentinel");
    expect(readyDiscovery.fake.orderTransition).toHaveBeenCalledTimes(1);
  });
});

describe("cancelOrder cancellation CAS (D7.3)", () => {
  const cancelledOrder = {
    ...makeOrder(),
    status: "CANCELLED" as const,
    cancelled_at: "2026-08-24T09:00:00.000Z",
    cancelled_by: "user-9",
  };

  function casCancel(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
    options: { lockedOrder?: DineInOrderDTO } = {},
  ) {
    const order = options.lockedOrder ?? { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A. PLACED + OPEN reaches the cancellation CAS once", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("B. exact CAS expected/target: PLACED / CANCELLED", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    // The 4th (metadata) argument content is owned by R2.4; assert shape only.
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "PLACED",
      "CANCELLED",
      expect.any(Object),
    );
  });

  it("C. UPDATED returns the authoritative transition.value with eventFacts []", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    const cancelled = { ...makeOrder(), status: "CANCELLED" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(cancelled);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("D. PREPARING + OPEN/ACTIVE reaches the cancellation CAS once", async () => {
    for (const sessionStatus of ["OPEN", "ACTIVE"] as const) {
      const { fake } = casCancel("PREPARING", sessionStatus);
      fake.orderTransition.mockRejectedValue(new Error("CAS-reached-sentinel"));
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      const err = await captureError(svc.cancelOrder(baseCancelInput));
      expect(err.message).toBe("CAS-reached-sentinel");
      expect(fake.orderTransition).toHaveBeenCalledTimes(1);
    }
  });

  it("E. exact CAS expected/target: PREPARING / CANCELLED", async () => {
    const { fake } = casCancel("PREPARING", "OPEN");
    fake.orderTransition.mockRejectedValue(new Error("CAS-reached-sentinel"));
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await captureError(svc.cancelOrder(baseCancelInput));
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "PREPARING",
      "CANCELLED",
      expect.any(Object),
    );
  });

  it("F. NOT_FOUND -> ORDER_NOT_FOUND 404", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({ kind: "NOT_FOUND" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("G. STATE_MISMATCH -> INVALID_DINE_IN_TRANSITION 409", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "SERVED" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("H. STATE_MISMATCH current=CANCELLED stays 409 (no convergence success)", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "CANCELLED" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    // No DTO fabrication, no second convergence read, no idempotent success.
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("I. locked CANCELLED -> IDEMPOTENT_NO_MUTATION with no CAS", async () => {
    const { fake } = casCancel("CANCELLED", "OPEN", { lockedOrder: cancelledOrder });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("J. READY_TO_SERVE -> ORDER_NOT_CANCELLABLE with no CAS", async () => {
    const { fake } = casCancel("READY_TO_SERVE", "OPEN");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("K. SERVED -> ORDER_NOT_CANCELLABLE with no CAS", async () => {
    const { fake } = casCancel("SERVED", "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("L. billed PLACED/PREPARING -> BILL_FROZEN with no CAS", async () => {
    for (const [orderStatus, sessionStatus] of [
      ["PLACED", "BILL_REQUESTED"],
      ["PREPARING", "PAYMENT_PENDING"],
    ] as const) {
      const { fake } = casCancel(orderStatus, sessionStatus);
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
        code: "BILL_FROZEN",
        status: 409,
      });
      expect(fake.orderTransition).not.toHaveBeenCalled();
    }
  });

  it("M. no-second-read: single discovery + session lock + order lock + CAS on success and failure paths", async () => {
    const success = casCancel("PLACED", "OPEN");
    success.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svcS = new DineInOrderService(success.fake.port, makeFakeCatalog().catalog);
    await svcS.cancelOrder(baseCancelInput);
    expect(success.fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(success.fake.lockById).toHaveBeenCalledTimes(1);
    expect(success.fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(success.fake.orderTransition).toHaveBeenCalledTimes(1);

    const failure = casCancel("PLACED", "OPEN");
    failure.fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "SERVED" });
    const svcF = new DineInOrderService(failure.fake.port, makeFakeCatalog().catalog);
    await svcF.cancelOrder(baseCancelInput).catch(() => undefined);
    expect(failure.fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(failure.fake.lockById).toHaveBeenCalledTimes(1);
    expect(failure.fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(failure.fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("N. D8.1: ACTIVE success performs one post-CAS sibling read; OPEN performs none", async () => {
    // D8.1 (accepted): an ACTIVE successful cancellation performs exactly
    // one post-CAS sibling read, scoped to the locked session, used only for
    // final-billable determination. A non-final read means no reopen (D8.2
    // reopens only when every sibling is CANCELLED), so no session mutation.
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    // Exactly one sibling read, scoped to the locked session id.
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledTimes(1);
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledWith("session-1");
    // The sibling read happens only after the successful cancellation CAS.
    const casOrder = fake.orderTransition.mock.invocationCallOrder[0]!;
    const siblingOrder = fake.orderGetBySessionWithItems.mock.invocationCallOrder[0]!;
    expect(casOrder).toBeLessThan(siblingOrder);
    // Non-final cancellation -> NEW_MUTATION, no session mutation, no reopen.
    expect(fake.sessionTransition).not.toHaveBeenCalled();

    // OPEN success performs NO sibling read (no reopen determination).
    const open = casCancel("PLACED", "OPEN");
    open.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svcOpen = new DineInOrderService(open.fake.port, makeFakeCatalog().catalog);
    const openOutcome = await svcOpen.cancelOrder(baseCancelInput);
    expect(openOutcome.kind).toBe("NEW_MUTATION");
    expect(open.fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
  });

  it("O. D8.2: ACTIVE final cancellation reopens the session ACTIVE->OPEN and returns NEW_MUTATION", async () => {
    // Final cancellation: the post-CAS sibling read shows ZERO non-CANCELLED
    // orders, so the session is compensated ACTIVE -> OPEN inside the same
    // transaction. The public result keeps the D7 shape: NEW_MUTATION with the
    // authoritative cancelled order DTO and no facts.
    const { fake } = casCancel("PLACED", "ACTIVE");
    const cancelled = { ...makeOrder(), status: "CANCELLED" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    // E/F/G: UPDATED -> NEW_MUTATION, authoritative transition.value, no facts.
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(cancelled);
    expect(outcome.eventFacts).toEqual([]);
    // A: order CAS -> sibling read [] -> session ACTIVE->OPEN CAS.
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledTimes(1);
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledWith("session-1");
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("P. D8.2: exact session CAS args are session.id / ACTIVE / OPEN with no extra metadata", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
    // Exact expected/target pair from the authoritative locked session.
    expect(fake.sessionTransition).toHaveBeenCalledWith("session-1", "ACTIVE", "OPEN");
  });

  it("Q. D8.2: session CAS runs after the order cancellation CAS and after the sibling read", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    const casOrder = fake.orderTransition.mock.invocationCallOrder[0]!;
    const readOrder = fake.orderGetBySessionWithItems.mock.invocationCallOrder[0]!;
    const reopenOrder = fake.sessionTransition.mock.invocationCallOrder[0]!;
    // C: reopen strictly after the order CAS; D: reopen strictly after the read.
    expect(casOrder).toBeLessThan(reopenOrder);
    expect(readOrder).toBeLessThan(reopenOrder);
  });

  it("R. D8.2: non-final ACTIVE cancellation (PLACED sibling remains) performs no session transition", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("S. D8.2: a READY_TO_SERVE sibling prevents the reopen", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([
      makeOrderWithItems({ id: "order-2", status: "READY_TO_SERVE" }),
    ]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("T. D8.2: a SERVED sibling prevents the reopen", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([
      makeOrderWithItems({ id: "order-2", status: "SERVED" }),
    ]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("U. D8.2: only CANCELLED siblings remain -> the session reopens", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    // A CANCELLED sibling plus the just-cancelled order: nothing non-CANCELLED.
    fake.orderGetBySessionWithItems.mockResolvedValue([
      makeOrderWithItems({ id: "order-2", status: "CANCELLED" }),
    ]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("V. D8.2: session CAS NOT_FOUND rejects defensively with INTERNAL_ERROR 500", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    // Fake default returns NOT_FOUND for the session CAS.
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("W. D8.2: session CAS STATE_MISMATCH rejects defensively with INTERNAL_ERROR 500", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "OPEN" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
  });

  it("X. D8.2: OPEN cancellation performs no sibling read and no session transition", async () => {
    const { fake } = casCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("Y. D8.2: already-CANCELLED retry stays idempotent with no sibling read and no session transition", async () => {
    const { fake } = casCancel("CANCELLED", "ACTIVE", { lockedOrder: cancelledOrder });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("Z. D8.2: the final-cancel reopen runs inside the single runInTransaction", async () => {
    const { fake } = casCancel("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    // Exactly one transaction wraps discovery + locks + CAS + read + reopen.
    expect(fake.runInTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("cancelOrder cancellation audit metadata (D7.4)", () => {
  function auditCancel(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
    options: { lockedOrder?: DineInOrderDTO } = {},
  ) {
    const order = options.lockedOrder ?? { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  function metadataOf(fake: ReturnType<typeof auditCancel>["fake"]): {
    cancelled_at?: string;
    cancelled_by?: string;
  } {
    return fake.orderTransition.mock.calls[0]![3] as {
      cancelled_at?: string;
      cancelled_by?: string;
    };
  }

  it("A. cancelled_at is server-generated, present, and ISO-parseable on the mutation path", async () => {
    for (const orderStatus of ["PLACED", "PREPARING"] as const) {
      const { fake } = auditCancel(orderStatus, "OPEN");
      fake.orderTransition.mockResolvedValue({
        kind: "UPDATED",
        value: { ...makeOrder(), status: "CANCELLED" },
      });
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await svc.cancelOrder(baseCancelInput);
      const metadata = metadataOf(fake);
      expect(metadata.cancelled_at).toBeTypeOf("string");
      expect(Number.isNaN(Date.parse(metadata.cancelled_at!))).toBe(false);
    }
  });

  it("B. cancelled_by equals input.caller_user_id", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(metadataOf(fake).cancelled_by).toBe(baseCancelInput.caller_user_id);
  });

  it("C. metadata keys are exactly cancelled_at and cancelled_by", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(Object.keys(metadataOf(fake)).sort()).toEqual(["cancelled_at", "cancelled_by"]);
  });

  it("D. one transitionStatus call carries both audit fields in the 4th argument", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
    expect(metadataOf(fake)).toEqual({
      cancelled_at: expect.any(String),
      cancelled_by: "user-1",
    });
  });

  it("E. UPDATED returns the authoritative transition.value with eventFacts []", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    const cancelled = { ...makeOrder(), status: "CANCELLED" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(cancelled);
    expect(outcome.eventFacts).toEqual([]);
  });

  it("F. already-CANCELLED retry preserves existing audit fields with no CAS", async () => {
    const cancelled = {
      ...makeOrder(),
      status: "CANCELLED" as const,
      cancelled_at: "2026-08-24T09:00:00.000Z",
      cancelled_by: "user-9",
    };
    const { fake, order } = auditCancel("CANCELLED", "OPEN", { lockedOrder: cancelled });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(order);
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("G. NOT_FOUND -> ORDER_NOT_FOUND 404 with no metadata retry", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({ kind: "NOT_FOUND" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      status: 404,
    });
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("H. STATE_MISMATCH -> INVALID_DINE_IN_TRANSITION 409 with no second read", async () => {
    const { fake } = auditCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({ kind: "STATE_MISMATCH", current: "SERVED" });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
  });

  it("I. D8.1 audit-framed: ACTIVE non-final success keeps audit DTO and performs one scoped sibling read", async () => {
    // D8.1 (accepted) under the D7.4 audit framing: an ACTIVE non-final
    // successful cancellation returns the authoritative UPDATED DTO with audit
    // fields unchanged and performs exactly one post-CAS sibling read scoped to
    // the locked session, for final-billable determination only. No session
    // mutation; OPEN performs no sibling read.
    const { fake } = auditCancel("PLACED", "ACTIVE");
    const cancelled = { ...makeOrder(), status: "CANCELLED" as const };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    // Authoritative UPDATED DTO with audit fields unchanged (no regeneration).
    expect((outcome.value as CancelOrderResult).order).toEqual(cancelled);
    expect(outcome.eventFacts).toEqual([]);
    // Exactly one sibling read, scoped to the locked session id, after the CAS.
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledTimes(1);
    expect(fake.orderGetBySessionWithItems).toHaveBeenCalledWith("session-1");
    const casOrder = fake.orderTransition.mock.invocationCallOrder[0]!;
    const siblingOrder = fake.orderGetBySessionWithItems.mock.invocationCallOrder[0]!;
    expect(casOrder).toBeLessThan(siblingOrder);
    // Non-final ACTIVE -> no session transition (D8.2 reopens only on final).
    expect(fake.sessionTransition).not.toHaveBeenCalled();

    // OPEN success performs NO sibling read.
    const open = auditCancel("PLACED", "OPEN");
    open.fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    const svcOpen = new DineInOrderService(open.fake.port, makeFakeCatalog().catalog);
    const openOutcome = await svcOpen.cancelOrder(baseCancelInput);
    expect(openOutcome.kind).toBe("NEW_MUTATION");
    expect(open.fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
  });
});

describe("cancelOrder retry + no-second-read hardening (D7.5)", () => {
  const cancelledOrder = {
    ...makeOrder(),
    status: "CANCELLED" as const,
    cancelled_at: "2026-08-24T09:00:00.000Z",
    cancelled_by: "user-9",
  };

  function retryCancel(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
    options: { lockedOrder?: DineInOrderDTO } = {},
  ) {
    const order = options.lockedOrder ?? { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A. already-CANCELLED retry is idempotent across all five session states with audit preservation", async () => {
    for (const sessionStatus of [
      "OPEN",
      "ACTIVE",
      "BILL_REQUESTED",
      "PAYMENT_PENDING",
      "CLOSED",
    ] as const) {
      const { fake, order } = retryCancel("CANCELLED", sessionStatus, {
        lockedOrder: cancelledOrder,
      });
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      const outcome = await svc.cancelOrder(baseCancelInput);
      expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
      expect((outcome.value as CancelOrderResult).order).toEqual(order);
      expect(outcome.eventFacts).toEqual([]);
      // Existing audit values returned unchanged; no new timestamp generated.
      const returned = (outcome.value as CancelOrderResult).order;
      expect(returned.cancelled_at).toBe("2026-08-24T09:00:00.000Z");
      expect(returned.cancelled_by).toBe("user-9");
      // No cancellation CAS, no sibling reread, no audit rewrite, no session
      // transition. Idempotency exits strictly before any compensation logic.
      expect(fake.orderTransition).not.toHaveBeenCalled();
      expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
      expect(fake.sessionTransition).not.toHaveBeenCalled();
    }
  });

  it("B. success path performs exactly one of each service-level read, no convergence read", async () => {
    const { fake } = retryCancel("PLACED", "OPEN");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(fake.lockById).toHaveBeenCalledTimes(1);
    expect(fake.orderLockById).toHaveBeenCalledTimes(1);
    expect(fake.orderTransition).toHaveBeenCalledTimes(1);
  });

  it("C. failure matrix performs no convergence read and no retry CAS", async () => {
    const failures: Array<{
      result: TransitionResult<DineInOrderDTO, DineInOrderStatus>;
      code: string;
      status: number;
    }> = [
      { result: { kind: "NOT_FOUND" }, code: "ORDER_NOT_FOUND", status: 404 },
      {
        result: { kind: "STATE_MISMATCH", current: "SERVED" },
        code: "INVALID_DINE_IN_TRANSITION",
        status: 409,
      },
      {
        result: { kind: "STATE_MISMATCH", current: "CANCELLED" },
        code: "INVALID_DINE_IN_TRANSITION",
        status: 409,
      },
    ];
    for (const failure of failures) {
      const { fake } = retryCancel("PLACED", "OPEN");
      fake.orderTransition.mockResolvedValue(failure.result);
      const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
      await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
        code: failure.code,
        status: failure.status,
      });
      // No second service-level getById, no DTO fabrication, no retry CAS.
      expect(fake.orderGetById).toHaveBeenCalledTimes(1);
      expect(fake.lockById).toHaveBeenCalledTimes(1);
      expect(fake.orderLockById).toHaveBeenCalledTimes(1);
      expect(fake.orderTransition).toHaveBeenCalledTimes(1);
    }
  });

  it("D8.3: post-compensation retry (CANCELLED order + OPEN session) stays pre-CAS idempotent", async () => {
    // State after a successful final ACTIVE cancellation + ACTIVE->OPEN
    // compensation (D8.2): the order is CANCELLED and the session is OPEN.
    // A retry must return the locked DTO idempotently and exit before any
    // order CAS, sibling reread, or OPEN->OPEN session transition.
    const { fake, order } = retryCancel("CANCELLED", "OPEN", {
      lockedOrder: cancelledOrder,
    });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("IDEMPOTENT_NO_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(order);
    expect(outcome.eventFacts).toEqual([]);
    // Audit preserved (no rewrite): exact cancelled_at / cancelled_by returned.
    const returned = (outcome.value as CancelOrderResult).order;
    expect(returned.cancelled_at).toBe("2026-08-24T09:00:00.000Z");
    expect(returned.cancelled_by).toBe("user-9");
    // No order CAS, no sibling reread, no OPEN->OPEN session transition.
    expect(fake.orderTransition).not.toHaveBeenCalled();
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// D2.5D8.4: cancel-wins x requestBill deterministic interleaving.
// Service-level sequence only — no real-PG concurrency (that is D2.5I).
// requestBill is NOT modified; this models the frozen OPEN rule and proves:
// IF the final-cancel transaction commits first (session -> OPEN),
// THEN a later requestBill sees OPEN and fails SESSION_NOT_BILLABLE with no
// SessionBill / BRING_BILL / session transition / payment work.
// ------------------------------------------------------------
describe("cancelOrder wins before requestBill (D8.4)", () => {
  const rbInput: RequestBillInput = {
    session_id: "session-1",
    caller_user_id: "user-1",
    correlation_id: "corr-rb",
  };

  // Minimal requestBill transaction fake: locks the given session and tracks
  // every bill/request/transition/list read so absence can be proven.
  function makeRbPortLocking(session: DiningSessionDTO | null) {
    const mocks = {
      lockById: vi.fn().mockResolvedValue(session),
      getBySessionId: vi.fn().mockResolvedValue(null),
      createFrozenBill: vi.fn().mockResolvedValue({ id: "bill-1" }),
      findBringBillBySession: vi.fn().mockResolvedValue({ kind: "NONE" }),
      createRequest: vi.fn().mockResolvedValue({ id: "req-1" }),
      transitionStatus: vi.fn().mockResolvedValue({ kind: "UPDATED" }),
      listForBill: vi.fn().mockResolvedValue([]),
    };
    const repos = {
      diningSessions: {
        lockById: mocks.lockById,
        transitionStatus: mocks.transitionStatus,
      },
      sessionBills: {
        getBySessionId: mocks.getBySessionId,
        createFrozenBill: mocks.createFrozenBill,
      },
      serviceRequests: {
        findBringBillBySession: mocks.findBringBillBySession,
        create: mocks.createRequest,
      },
      dineInOrders: {
        listForBill: mocks.listForBill,
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => fn(repos),
    } as unknown as DineInTransactionPort;
    return { port, mocks };
  }

  // Local copy of the D7.3 casCancel fixture (that helper is block-scoped).
  function cancelFake(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
  ) {
    const order = { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A/G/H: final ACTIVE PLACED cancel -> NEW_MUTATION + ACTIVE->OPEN once, audit unchanged", async () => {
    const { fake } = cancelFake("PLACED", "ACTIVE");
    const cancelled = {
      ...makeOrder(),
      status: "CANCELLED" as const,
      cancelled_at: "2026-08-24T09:00:00.000Z",
      cancelled_by: "user-1",
    };
    fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    // G: NEW_MUTATION; authoritative cancelled order; no facts.
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order).toEqual(cancelled);
    expect(outcome.eventFacts).toEqual([]);
    // A: session ACTIVE->OPEN happened exactly once.
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).toHaveBeenCalledWith("session-1", "ACTIVE", "OPEN");
  });

  it("B: the same reopen holds for a final PREPARING cancellation", async () => {
    const { fake } = cancelFake("PREPARING", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    expect(fake.sessionTransition).toHaveBeenCalledTimes(1);
    expect(fake.sessionTransition).toHaveBeenCalledWith("session-1", "ACTIVE", "OPEN");
  });

  it("C-F/K: requestBill after the final cancel sees OPEN -> SESSION_NOT_BILLABLE, zero bill/request/transition/payment work", async () => {
    // Post-compensation authoritative state: the session is OPEN. The bill tx
    // runs as a SEPARATE transaction after the cancel tx committed.
    const { port, mocks } = makeRbPortLocking(makeSession("OPEN"));
    const service = new DiningSessionService(port, vi.fn());
    await expect(service.requestBill(rbInput)).rejects.toMatchObject({
      code: "SESSION_NOT_BILLABLE",
      status: 400,
    });
    // D: no SessionBill insert. E: no BRING_BILL request. F: no session
    // transition (no self-heal back to ACTIVE/BILL_REQUESTED). K: no payment
    // work (no bill/list reads either — nothing runs before the throw).
    expect(mocks.createFrozenBill).not.toHaveBeenCalled();
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
    expect(mocks.getBySessionId).not.toHaveBeenCalled();
    expect(mocks.listForBill).not.toHaveBeenCalled();
  });

  it("J: both commands serialize on the shared session row first", async () => {
    // cancelOrder: session lock strictly precedes the order lock.
    const { fake } = cancelFake("PLACED", "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([]);
    fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput);
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(sessionLock).toBeLessThan(orderLock);
    // requestBill: session lock is its first and only call on the OPEN path
    // (it throws before any bill/request/transition read).
    const { port, mocks } = makeRbPortLocking(makeSession("OPEN"));
    const service = new DiningSessionService(port, vi.fn());
    await service.requestBill(rbInput).catch(() => undefined);
    expect(mocks.lockById).toHaveBeenCalledTimes(1);
    expect(mocks.getBySessionId).not.toHaveBeenCalled();
    expect(mocks.listForBill).not.toHaveBeenCalled();
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
    expect(mocks.createFrozenBill).not.toHaveBeenCalled();
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// D2.5D8.5: requestBill-wins x cancelOrder deterministic interleaving.
// The frozen opposite half of D8.4: IF requestBill commits first
// (session -> BILL_REQUESTED + frozen SessionBill + BRING_BILL), THEN a later
// PLACED/PREPARING cancellation is rejected BILL_FROZEN 409 BEFORE any order
// CAS, audit write, sibling read, or ACTIVE->OPEN compensation. The bill-wins
// outcome is terminal for this cancellation attempt (no self-heal/revert).
// Service-level sequence only — real-PG concurrency is D2.5I.
// ------------------------------------------------------------
describe("requestBill wins before cancelOrder (D8.5)", () => {
  const rbInput: RequestBillInput = {
    session_id: "session-1",
    caller_user_id: "user-1",
    correlation_id: "corr-rb",
  };

  const bill: SessionBillDTO = {
    id: "bill-1",
    session_id: "session-1",
    restaurant_id: "restaurant-1",
    food_subtotal: 100,
    packaging_fee: 0,
    gst_food: 5,
    gst_packaging: 0,
    total_amount: 105,
    frozen_at: "2026-08-24T09:00:00.000Z",
    created_at: "2026-08-24T09:00:00.000Z",
  };

  const bringBillRequest: ServiceRequestDTO = {
    id: "req-1",
    session_id: "session-1",
    restaurant_id: "restaurant-1",
    requested_by: "user-1",
    request_type: "BRING_BILL",
    status: "PENDING",
    note: null,
    acknowledged_by: null,
    acknowledged_at: null,
    completed_by: null,
    completed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-08-24T09:00:00.000Z",
    updated_at: "2026-08-24T09:00:00.000Z",
  };

  const billableOrder: DineInOrderWithItemsDTO = {
    ...makeOrder(),
    items: [
      {
        id: "oi-1",
        dine_in_order_id: "order-1",
        restaurant_id: "restaurant-1",
        menu_item_id: "item-1",
        name: "Paneer Tikka",
        base_price: 100,
        quantity: 1,
        customizations: [],
        customization_total: 0,
        item_subtotal: 100,
        created_at: "2026-08-24T00:00:00.000Z",
      },
    ],
  };

  // requestBill transaction fake wired for the ACTIVE success path: it locks
  // the ACTIVE session and produces the frozen-bill artifacts.
  function makeRbPortFreezing(session: DiningSessionDTO) {
    const billed = {
      ...session,
      status: "BILL_REQUESTED" as const,
      bill_requested_at: "2026-08-24T09:00:00.000Z",
    };
    const mocks = {
      lockById: vi.fn().mockResolvedValue(session),
      getBySessionId: vi.fn().mockResolvedValue(null),
      listForBill: vi.fn().mockResolvedValue([billableOrder]),
      createFrozenBill: vi.fn().mockResolvedValue(bill),
      transitionStatus: vi.fn().mockResolvedValue({ kind: "UPDATED", value: billed }),
      findBringBillBySession: vi.fn().mockResolvedValue({ kind: "NONE" }),
      createRequest: vi.fn().mockResolvedValue(bringBillRequest),
    };
    const repos = {
      diningSessions: {
        lockById: mocks.lockById,
        transitionStatus: mocks.transitionStatus,
      },
      sessionBills: {
        getBySessionId: mocks.getBySessionId,
        createFrozenBill: mocks.createFrozenBill,
      },
      serviceRequests: {
        findBringBillBySession: mocks.findBringBillBySession,
        create: mocks.createRequest,
      },
      dineInOrders: {
        listForBill: mocks.listForBill,
      },
    } as unknown as DineInTransactionRepos;
    const port = {
      runInTransaction: async <T>(
        fn: (r: DineInTransactionRepos) => Promise<T>,
      ): Promise<T> => fn(repos),
    } as unknown as DineInTransactionPort;
    return { port, mocks };
  }

  // Local cancellation fixture (same shape as the D7.3/D8.4 helpers).
  function cancelFake(
    orderStatus: DineInOrderDTO["status"],
    sessionStatus: DiningSessionStatus,
  ) {
    const order = { ...makeOrder(), status: orderStatus };
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    return { fake, order };
  }

  it("A-D: requestBill wins from ACTIVE -> NEW_MUTATION, BILL_REQUESTED, SessionBill + BRING_BILL created", async () => {
    const { port, mocks } = makeRbPortFreezing(makeSession("ACTIVE"));
    const service = new DiningSessionService(port, vi.fn());
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    // B: session ACTIVE -> BILL_REQUESTED.
    expect(outcome.value.session.status).toBe("BILL_REQUESTED");
    // C: authoritative frozen SessionBill created and returned.
    expect(outcome.value.bill).toEqual(bill);
    // D: BRING_BILL ServiceRequest created and returned.
    expect(outcome.value.bringBillRequest).not.toBeNull();
    expect(outcome.value.bringBillRequest!.request_type).toBe("BRING_BILL");
    // L: requestBill locked the session first (before any bill read).
    expect(mocks.lockById).toHaveBeenCalledTimes(1);
    expect(mocks.transitionStatus).toHaveBeenCalledWith(
      "session-1",
      "ACTIVE",
      "BILL_REQUESTED",
      expect.any(Object),
    );
  });

  it("E: full sequence — requestBill commits, then PLACED cancel sees the committed BILL_REQUESTED session -> BILL_FROZEN 409", async () => {
    // 1. requestBill wins and commits the frozen bill.
    const { port } = makeRbPortFreezing(makeSession("ACTIVE"));
    const service = new DiningSessionService(port, vi.fn());
    const outcome = (await service.requestBill(rbInput)) as MutationOutcome<
      RequestBillResult,
      DineInEventFact
    >;
    expect(outcome.kind).toBe("NEW_MUTATION");
    // 2. cancelOrder runs in its OWN transaction against the committed
    //    BILL_REQUESTED session (not a fake ACTIVE session).
    const order: DineInOrderDTO = { ...makeOrder(), status: "PLACED" };
    const fake = makeFakeTxPort(outcome.value.session);
    fake.orderGetById.mockResolvedValue(order);
    fake.orderLockById.mockResolvedValue(order);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    // G: no order CAS; H: no audit metadata write; I: no sibling read;
    // J: no ACTIVE->OPEN compensation.
    expect(fake.orderTransition).not.toHaveBeenCalled();
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("F: later PREPARING cancel sees BILL_REQUESTED -> BILL_FROZEN 409", async () => {
    const { fake } = cancelFake("PREPARING", "BILL_REQUESTED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "BILL_FROZEN",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
  });

  it("G-K: BILL_FROZEN cancel performs zero cancellation and zero bill work", async () => {
    const { fake } = cancelFake("PLACED", "BILL_REQUESTED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput).catch(() => undefined);
    // G: no order transitionStatus. H: no audit write (no CAS metadata at all).
    expect(fake.orderTransition).not.toHaveBeenCalled();
    // I: no sibling read. J: no reopen compensation.
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
    expect(fake.sessionTransition).not.toHaveBeenCalled();
    // K: the cancel transaction exposes no bill repo at all, so the frozen
    // SessionBill / BRING_BILL artifacts cannot be rewritten or reverted.
    // The only calls are the service-level discovery + the two locks.
    expect(fake.orderGetById).toHaveBeenCalledTimes(1);
    expect(fake.lockById).toHaveBeenCalledTimes(1);
    expect(fake.orderLockById).toHaveBeenCalledTimes(1);
  });

  it("L: both commands serialize on the shared session row first", async () => {
    // requestBill: session lock is the first persistence call of its tx.
    const { port, mocks } = makeRbPortFreezing(makeSession("ACTIVE"));
    const service = new DiningSessionService(port, vi.fn());
    await service.requestBill(rbInput);
    expect(mocks.lockById).toHaveBeenCalledTimes(1);
    // cancelOrder: session lock strictly precedes the order lock.
    const { fake } = cancelFake("PLACED", "BILL_REQUESTED");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await svc.cancelOrder(baseCancelInput).catch(() => undefined);
    const sessionLock = fake.lockById.mock.invocationCallOrder[0]!;
    const orderLock = fake.orderLockById.mock.invocationCallOrder[0]!;
    expect(sessionLock).toBeLessThan(orderLock);
  });
});

// ------------------------------------------------------------
// D2.5D8.6: advanceOrder x cancelOrder deterministic interleaving.
// Both commands share the NON-LOCKING discovery -> session lock -> order lock
// discipline, so the winner's COMMITTED state is authoritative input for the
// later command. No Promise.all, no sleeps, no real DB — service-level
// sequencing only (real-PG serialization is D2.5I).
// ------------------------------------------------------------
describe("advanceOrder x cancelOrder interleaving (D8.6)", () => {
  // Local fixture: discovery + both locks return the given locked order under
  // the given session status (winner #1's committed DTO feeds command #2).
  function commandFake(
    lockedOrder: DineInOrderDTO,
    sessionStatus: DiningSessionStatus = "ACTIVE",
  ) {
    const fake = makeFakeTxPort(makeSession(sessionStatus));
    fake.orderGetById.mockResolvedValue(lockedOrder);
    fake.orderLockById.mockResolvedValue(lockedOrder);
    return { fake, order: lockedOrder };
  }

  it("A: cancel-first (PLACED -> CANCELLED) invalidates a later PREPARING advance -> 409", async () => {
    // Winner #1: cancelOrder commits PLACED -> CANCELLED (non-final, so the
    // D8.2 reopen does not interfere with the order-state outcome).
    const win = commandFake(makeOrder(), "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    win.fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.cancelOrder(baseCancelInput);
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    const committed = (winOutcome.value as CancelOrderResult).order;
    // Command #2: advanceOrder evaluates from the winner's committed state.
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.advanceOrder(baseAdvanceInput)).rejects.toMatchObject({
      code: "INVALID_DINE_IN_TRANSITION",
      status: 409,
    });
    // CANCELLED has no forward edge: no advance CAS attempted.
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("B: cancel-first (PREPARING -> CANCELLED) invalidates a later READY_TO_SERVE advance -> 409", async () => {
    const win = commandFake({ ...makeOrder(), status: "PREPARING" }, "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    win.fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.cancelOrder(baseCancelInput);
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    const committed = (winOutcome.value as CancelOrderResult).order;
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "READY_TO_SERVE" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("C: advance-first (PLACED -> PREPARING) still allows a later cancel -> NEW_MUTATION", async () => {
    // Winner #1: advanceOrder commits PLACED -> PREPARING.
    const win = commandFake(makeOrder(), "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.advanceOrder(baseAdvanceInput);
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    const committed = (winOutcome.value as AdvanceOrderResult).order;
    // Command #2: PREPARING is still a cancellable source state.
    const { fake } = commandFake(committed, "ACTIVE");
    fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    const outcome = await svc.cancelOrder(baseCancelInput);
    expect(outcome.kind).toBe("NEW_MUTATION");
    expect((outcome.value as CancelOrderResult).order.status).toBe("CANCELLED");
    expect(fake.orderTransition).toHaveBeenCalledWith(
      "order-1",
      "PREPARING",
      "CANCELLED",
      expect.any(Object),
    );
  });

  it("D: advance-first (PREPARING -> READY_TO_SERVE) blocks later cancel -> ORDER_NOT_CANCELLABLE 409", async () => {
    const win = commandFake({ ...makeOrder(), status: "PREPARING" }, "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "READY_TO_SERVE" },
    });
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.advanceOrder({
      ...baseAdvanceInput,
      target_status: "READY_TO_SERVE",
    });
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    const committed = (winOutcome.value as AdvanceOrderResult).order;
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    // No cancellation CAS for READY_TO_SERVE.
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("E: advance-first (READY_TO_SERVE -> SERVED) blocks later cancel -> ORDER_NOT_CANCELLABLE 409", async () => {
    const win = commandFake({ ...makeOrder(), status: "READY_TO_SERVE" }, "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: {
        ...makeOrder(),
        status: "SERVED",
        served_at: "2026-08-24T10:00:00.000Z",
      },
    });
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.advanceOrder({
      ...baseAdvanceInput,
      target_status: "SERVED",
    });
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    const committed = (winOutcome.value as AdvanceOrderResult).order;
    expect(committed.served_at).toBe("2026-08-24T10:00:00.000Z");
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("F: cancel-first writes cancellation audit only; no served_at can be added later", async () => {
    const win = commandFake(makeOrder(), "ACTIVE");
    const cancelled = {
      ...makeOrder(),
      status: "CANCELLED" as const,
      cancelled_at: "2026-08-24T09:00:00.000Z",
      cancelled_by: "user-1",
    };
    win.fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: cancelled });
    win.fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.cancelOrder(baseCancelInput);
    const committed = (winOutcome.value as CancelOrderResult).order;
    // Winner wrote exactly the cancellation audit fields, and no served_at.
    expect(committed.cancelled_at).toBe("2026-08-24T09:00:00.000Z");
    expect(committed.cancelled_by).toBe("user-1");
    expect(committed.served_at).toBeNull();
    // A later SERVED advance is rejected without touching served_at.
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(
      svc.advanceOrder({ ...baseAdvanceInput, target_status: "SERVED" }),
    ).rejects.toMatchObject({ code: "INVALID_DINE_IN_TRANSITION", status: 409 });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("G: served-first writes served_at; later cancel writes no cancellation audit", async () => {
    const win = commandFake({ ...makeOrder(), status: "READY_TO_SERVE" }, "ACTIVE");
    const served = {
      ...makeOrder(),
      status: "SERVED" as const,
      served_at: "2026-08-24T10:00:00.000Z",
    };
    win.fake.orderTransition.mockResolvedValue({ kind: "UPDATED", value: served });
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.advanceOrder({
      ...baseAdvanceInput,
      target_status: "SERVED",
    });
    const committed = (winOutcome.value as AdvanceOrderResult).order;
    expect(committed.served_at).toBe("2026-08-24T10:00:00.000Z");
    const { fake } = commandFake(committed, "ACTIVE");
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    // No cancellation audit write, no sibling read.
    expect(fake.orderTransition).not.toHaveBeenCalled();
    expect(fake.orderGetBySessionWithItems).not.toHaveBeenCalled();
  });

  it("H: command #2 evaluates from the LOCKED order, never from stale discovery state", async () => {
    // Discovery (non-locking, stale) says PLACED, but the locked order is the
    // winner's committed READY_TO_SERVE. cancelOrder must follow the LOCKED
    // state, not the stale discovery DTO.
    const staleDiscovered = makeOrder();
    const locked = { ...makeOrder(), status: "READY_TO_SERVE" as const };
    const fake = makeFakeTxPort(makeSession("ACTIVE"));
    fake.orderGetById.mockResolvedValue(staleDiscovered);
    fake.orderLockById.mockResolvedValue(locked);
    const svc = new DineInOrderService(fake.port, makeFakeCatalog().catalog);
    await expect(svc.cancelOrder(baseCancelInput)).rejects.toMatchObject({
      code: "ORDER_NOT_CANCELLABLE",
      status: 409,
    });
    expect(fake.orderTransition).not.toHaveBeenCalled();
  });

  it("I: both commands preserve the session -> order lock discipline", async () => {
    const cancelWin = commandFake(makeOrder(), "ACTIVE");
    cancelWin.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    cancelWin.fake.orderGetBySessionWithItems.mockResolvedValue([remainingSibling]);
    const svcC = new DineInOrderService(cancelWin.fake.port, makeFakeCatalog().catalog);
    await svcC.cancelOrder(baseCancelInput);
    expect(cancelWin.fake.lockById.mock.invocationCallOrder[0]!).toBeLessThan(
      cancelWin.fake.orderLockById.mock.invocationCallOrder[0]!,
    );

    const advWin = commandFake(makeOrder(), "ACTIVE");
    advWin.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "PREPARING" },
    });
    const svcA = new DineInOrderService(advWin.fake.port, makeFakeCatalog().catalog);
    await svcA.advanceOrder(baseAdvanceInput);
    expect(advWin.fake.lockById.mock.invocationCallOrder[0]!).toBeLessThan(
      advWin.fake.orderLockById.mock.invocationCallOrder[0]!,
    );
  });

  it("J: cancel-first final order still performs the D8.2 ACTIVE->OPEN compensation", async () => {
    const win = commandFake(makeOrder(), "ACTIVE");
    win.fake.orderTransition.mockResolvedValue({
      kind: "UPDATED",
      value: { ...makeOrder(), status: "CANCELLED" },
    });
    win.fake.orderGetBySessionWithItems.mockResolvedValue([]);
    win.fake.sessionTransition.mockResolvedValue({ kind: "UPDATED", value: makeSession("OPEN") });
    const svcW = new DineInOrderService(win.fake.port, makeFakeCatalog().catalog);
    const winOutcome = await svcW.cancelOrder(baseCancelInput);
    expect(winOutcome.kind).toBe("NEW_MUTATION");
    // D8.2 compensation survives the interleaving framing.
    expect(win.fake.sessionTransition).toHaveBeenCalledTimes(1);
    expect(win.fake.sessionTransition).toHaveBeenCalledWith("session-1", "ACTIVE", "OPEN");
  });
});
