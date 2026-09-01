import { describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../lib/dbType";
import { DineInOrderService } from "../services/dineInOrder";
import { DiningSessionService } from "../services/dineInSession";
import {
  emitDineInEventFactsBestEffort,
  type DineInEventFactEmitter,
} from "../services/dineInEventEmitter";
import type { CatalogRepository, MenuItemDTO } from "./catalogRepository";
import type {
  DineInTransactionRepos,
  RestaurantEligibilityDTO,
  RestaurantTableDTO,
} from "./dineInContracts";
import { getStorageMode } from "./shared";
import {
  buildDineInTransactionPort,
  getDineInTransactionPort,
  resetDineInState,
} from "./dineInComposition";
import {
  buildMemoryDineInRepos,
  MemoryDineInTransactionPort,
} from "./dineInMemoryRepositories";
import { DrizzleDineInTransactionPort } from "./drizzle/dineInTransactionPort";

// ------------------------------------------------------------
// H2.1 Dine-In runtime composition tests.
//
// Verifies the storage-mode transaction-port wiring WITHOUT any HTTP
// layer: both Dine-In services are constructible from the port alone, and
// session / order / service-request / bill state is shared through ONE
// logical repository universe (the memory tx port + shared repo set).
// No route/auth/security dependency is required (G).
// ------------------------------------------------------------

const noopEmitter: DineInEventFactEmitter = async () => {};

function makeTable(overrides: Partial<RestaurantTableDTO> = {}): RestaurantTableDTO {
  return {
    id: "table-1",
    restaurant_id: "restaurant-1",
    zone_id: null,
    label: "T1",
    table_token: "token-abc",
    seat_count: 4,
    is_active: true,
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

function makeEligibility(
  overrides: Partial<RestaurantEligibilityDTO> = {},
): RestaurantEligibilityDTO {
  return { id: "restaurant-1", is_active: true, ...overrides };
}

function seedRepos(repos: DineInTransactionRepos, table: RestaurantTableDTO) {
  const tableRepo = repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  };
  tableRepo._seed(table);
  const eligibilityRepo = repos.restaurantEligibility as unknown as {
    _seed(dto: RestaurantEligibilityDTO): RestaurantEligibilityDTO;
  };
  eligibilityRepo._seed(makeEligibility());
}

function makeCatalog(items: Record<string, MenuItemDTO | null> = {}) {
  const getMenuItemById = vi.fn(
    async (id: string) => (id in items ? items[id] : null),
  );
  return {
    catalog: { getMenuItemById } as unknown as CatalogRepository,
    getMenuItemById,
  };
}

describe("Dine-In runtime composition (H2.1)", () => {
  describe("storage-mode transaction port factory", () => {
    it("selects the memory transaction port for memory mode", () => {
      const port = buildDineInTransactionPort("memory");
      expect(port).toBeInstanceOf(MemoryDineInTransactionPort);
    });

    it("selects the Drizzle transaction port for postgres mode", () => {
      const fakeDb = {} as unknown as DrizzleDb;
      const port = buildDineInTransactionPort("postgres", fakeDb);
      expect(port).toBeInstanceOf(DrizzleDineInTransactionPort);
    });

    it("follows the project storage-mode convention (only memory|postgres)", () => {
      // In the test environment the shared storage-mode decision is memory.
      expect(getStorageMode()).toBe("memory");
      // The build factory type union is exactly the two project modes; any
      // other value is a compile-time error (no third branch exists).
      const modes: Array<"postgres" | "memory"> = ["postgres", "memory"];
      expect(modes).toContain(getStorageMode());
    });
  });

  describe("lazy singleton composition", () => {
    it("returns the SAME port instance and resolves to memory mode in test env", () => {
      const first = getDineInTransactionPort();
      const second = getDineInTransactionPort();
      expect(second).toBe(first);
      expect(first).toBeInstanceOf(MemoryDineInTransactionPort);
    });
  });

  describe("service construction requires only the port (+ catalog)", () => {
    it("constructs both Dine-In services with no route/auth dependency", () => {
      const port = buildDineInTransactionPort("memory");
      const { catalog } = makeCatalog();
      const sessionService = new DiningSessionService(port);
      const orderService = new DineInOrderService(port, catalog);
      expect(sessionService).toBeInstanceOf(DiningSessionService);
      expect(orderService).toBeInstanceOf(DineInOrderService);
    });

    it("defaults the event emitter to the accepted best-effort wiring", () => {
      const port = buildDineInTransactionPort("memory");
      const service = new DiningSessionService(port);
      const wired = (
        service as unknown as { emitFacts: DineInEventFactEmitter }
      ).emitFacts;
      expect(wired).toBe(emitDineInEventFactsBestEffort);
    });
  });

  describe("shared repository universe across services (memory tx port)", () => {
    it("shares session/order/request/bill state through one logical repo set", async () => {
      const repos = buildMemoryDineInRepos();
      const port = new MemoryDineInTransactionPort(repos);
      seedRepos(repos, makeTable());
      const { catalog } = makeCatalog({
        "item-1": makeMenuItem({ price: 100 }),
      });

      const sessionService = new DiningSessionService(port, noopEmitter);
      const orderService = new DineInOrderService(port, catalog);

      // openSession (DiningSessionService) creates an OPEN session.
      const opened = await sessionService.openSession({
        caller_user_id: "user-1",
        table_token: "token-abc",
        correlation_id: "corr-1",
      });
      if (opened.kind !== "NEW_MUTATION") {
        throw new Error(`expected NEW_MUTATION, got ${opened.kind}`);
      }
      expect(opened.value).toMatchObject({ kind: "CREATED" });
      const sessionId = opened.value.session.id;

      // placeOrder (DineInOrderService) sees the SAME session/order universe.
      const placed = await orderService.placeOrder({
        session_id: sessionId,
        caller_user_id: "user-1",
        correlation_id: "corr-2",
        items: [{ menu_item_id: "item-1", quantity: 2 }],
      });
      if (placed.kind !== "NEW_MUTATION") {
        throw new Error(`expected NEW_MUTATION, got ${placed.kind}`);
      }
      expect(placed.value.order.status).toBe("PLACED");
      expect(placed.value.order.items).toHaveLength(1);
      expect(placed.value.order.items[0]?.item_subtotal).toBe(200);

      // requestBill (DiningSessionService) freezes the bill from the SAME
      // order snapshots: 2 x 100 + 5% GST = 210, and creates BRING_BILL.
      const billed = await sessionService.requestBill({
        session_id: sessionId,
        caller_user_id: "user-1",
        correlation_id: "corr-3",
      });
      if (billed.kind !== "NEW_MUTATION") {
        throw new Error(`expected NEW_MUTATION, got ${billed.kind}`);
      }
      expect(billed.value.session.status).toBe("BILL_REQUESTED");
      expect(billed.value.bill.total_amount).toBe(210);
      if (billed.value.bringBillRequest === null) {
        throw new Error("expected BRING_BILL request on new mutation");
      }
      expect(billed.value.bringBillRequest.request_type).toBe("BRING_BILL");
      const billId = billed.value.bill.id;
      const bringBillId = billed.value.bringBillRequest.id;

      // requestBill retry is idempotent and returns the SAME persisted bill +
      // SAME BRING_BILL artifact (no duplicate writes).
      const retried = await sessionService.requestBill({
        session_id: sessionId,
        caller_user_id: "user-1",
        correlation_id: "corr-4",
      });
      if (retried.kind !== "IDEMPOTENT_NO_MUTATION") {
        throw new Error(`expected IDEMPOTENT_NO_MUTATION, got ${retried.kind}`);
      }
      expect(retried.eventFacts).toEqual([]);
      expect(retried.value.bill.id).toBe(billId);
      if (retried.value.bringBillRequest === null) {
        throw new Error("expected BRING_BILL request on idempotent retry");
      }
      expect(retried.value.bringBillRequest.id).toBe(bringBillId);
      expect(retried.value.session.status).toBe("BILL_REQUESTED");

      // createServiceRequest (DiningSessionService) shares the same service
      // request repository on the same session.
      const created = await sessionService.createServiceRequest({
        session_id: sessionId,
        caller_user_id: "user-1",
        correlation_id: "corr-5",
        request_type: "WATER",
      });
      if (created.kind !== "NEW_MUTATION") {
        throw new Error(`expected NEW_MUTATION, got ${created.kind}`);
      }
      expect(created.value.request.status).toBe("PENDING");
      expect(created.value.request.request_type).toBe("WATER");
    });
  });

  describe("resetDineInState", () => {
    it("clears the singleton in-memory repo set between tests", async () => {
      const port = getDineInTransactionPort();
      const repos = (port as unknown as { repos: DineInTransactionRepos }).repos;
      seedRepos(repos, makeTable({ id: "table-reset", table_token: "token-reset" }));

      const sessionService = new DiningSessionService(port, noopEmitter);

      // Seeded through the SINGLETON repo universe -> CREATED.
      const opened = await sessionService.openSession({
        caller_user_id: "user-1",
        table_token: "token-reset",
        correlation_id: "corr-1",
      });
      expect(opened.kind).toBe("NEW_MUTATION");

      // resetDineInState() clears ALL in-memory repos. Two probes prove the
      // table repo and the eligibility reader were each reset:
      //   (1) re-seed ONLY the table  -> still fails (eligibility gone)
      //   (2) re-seed ONLY eligibility -> still fails (table gone)
      resetDineInState();

      const tableRepo = repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      };
      const eligibilityRepo = repos.restaurantEligibility as unknown as {
        _seed(d: RestaurantEligibilityDTO): RestaurantEligibilityDTO;
      };

      tableRepo._seed(makeTable({ id: "table-reset", table_token: "token-reset" }));
      await expect(
        sessionService.openSession({
          caller_user_id: "user-1",
          table_token: "token-reset",
          correlation_id: "corr-2",
        }),
      ).rejects.toMatchObject({ code: "TABLE_NOT_FOUND" });

      resetDineInState();
      eligibilityRepo._seed(makeEligibility());
      await expect(
        sessionService.openSession({
          caller_user_id: "user-1",
          table_token: "token-reset",
          correlation_id: "corr-3",
        }),
      ).rejects.toMatchObject({ code: "TABLE_NOT_FOUND" });
    });
  });
});
