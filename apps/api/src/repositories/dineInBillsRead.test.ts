import { describe, expect, it } from "vitest";
import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
} from "@snakzap/types";
import type {
  DineInOrderWithItemsDTO,
  DineInTransactionRepos,
  DiningSessionDTO,
  DineZoneDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  SessionBillDTO,
} from "./dineInContracts";
import {
  buildMemoryDineInRepos,
  MemoryDineInBillReadRepository,
  MemoryDineInTableBoardRepository,
} from "./dineInMemoryRepositories";
import type {
  MemoryDiningSessionRepository,
  MemoryDineInOrderRepository,
  MemoryRestaurantTableRepository,
  MemoryServiceRequestRepository,
  MemorySessionBillRepository,
} from "./dineInMemoryRepositories";

// ------------------------------------------------------------
// DINE-OPS4-B1 vendor Dine-In bill read model (memory repository).
//
// Pure repository-level tests. The reader observes the SHARED memory universe
// built by buildMemoryDineInRepos (tables / sessions / orders / requests /
// bills) plus an optional table-board zone registry. Covers the frozen
// semantics: access-context minimality (invariant-free), queue membership +
// deterministic ordering, the exactly-one-BRING_BILL invariant (enforced only
// under BILL_REQUESTED and only in the post-auth reads), and full detail
// assembly (zone, orders excluding CANCELLED, delivered bill still readable).
// ------------------------------------------------------------

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";

const TABLE_1 = "10000000-0000-4000-8000-000000000001";
const TABLE_2 = "20000000-0000-4000-8000-000000000001";
const ZONE_1 = "40000000-0000-4000-8000-000000000001";

const SESSION_1 = "50000000-0000-4000-8000-000000000001";
const SESSION_2 = "60000000-0000-4000-8000-000000000001";

const BILL_1 = "a1000000-0000-4000-8000-000000000001";
const BILL_2 = "a2000000-0000-4000-8000-000000000001";
const REQ_1 = "b1000000-0000-4000-8000-000000000001";
const REQ_2 = "b2000000-0000-4000-8000-000000000001";

function makeTable(id: string, restaurantId: string, label: string): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: id === TABLE_1 ? ZONE_1 : null,
    label,
    table_token: `token-${id}`,
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeZone(id: string, restaurantId: string, name: string): DineZoneDTO {
  return {
    id,
    restaurant_id: restaurantId,
    name,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeSession(
  id: string,
  restaurantId: string,
  tableId: string,
  status: DiningSessionStatus,
  createdAt: string,
  billRequestedAt: string | null,
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: "u00000000-0000-4000-8000-000000000001",
    status,
    bill_requested_at: billRequestedAt,
    payment_pending_at: null,
    closed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeBill(
  id: string,
  sessionId: string,
  restaurantId: string,
  frozenAt: string,
): SessionBillDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    food_subtotal: 200,
    packaging_fee: 0,
    gst_food: 10,
    gst_packaging: 0,
    total_amount: 210,
    frozen_at: frozenAt,
    created_at: frozenAt,
  };
}

function makeBringBill(
  id: string,
  sessionId: string,
  restaurantId: string,
  status: ServiceRequestStatus,
  createdAt: string,
): ServiceRequestDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    requested_by: "u00000000-0000-4000-8000-000000000001",
    request_type: "BRING_BILL",
    status,
    note: null,
    acknowledged_by: status === "ACKNOWLEDGED" || status === "COMPLETED" ? "staff-1" : null,
    acknowledged_at: status === "ACKNOWLEDGED" || status === "COMPLETED" ? "2026-08-24T10:05:00.000Z" : null,
    completed_by: status === "COMPLETED" ? "staff-1" : null,
    completed_at: status === "COMPLETED" ? "2026-08-24T10:06:00.000Z" : null,
    cancelled_by: null,
    cancelled_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeOrder(
  id: string,
  sessionId: string,
  restaurantId: string,
  status: DineInOrderStatus,
  createdAt: string,
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: "u00000000-0000-4000-8000-000000000001",
    status,
    total_amount: 200,
    notes: null,
    served_at: status === "SERVED" ? "2026-08-24T10:00:00.000Z" : null,
    cancelled_at: status === "CANCELLED" ? "2026-08-24T10:00:30.000Z" : null,
    cancelled_by: status === "CANCELLED" ? "u00000000-0000-4000-8000-000000000001" : null,
    created_at: createdAt,
    updated_at: createdAt,
    items: [
      {
        id: `item-${id}`,
        dine_in_order_id: id,
        restaurant_id: restaurantId,
        menu_item_id: "menu-1",
        name: "Paneer Tikka",
        base_price: 100,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 200,
        created_at: createdAt,
      },
    ],
  };
}

function buildReader() {
  const repos = buildMemoryDineInRepos();
  const board = new MemoryDineInTableBoardRepository();
  const reader = new MemoryDineInBillReadRepository(
    repos.restaurantTables as unknown as MemoryRestaurantTableRepository,
    repos.diningSessions as unknown as MemoryDiningSessionRepository,
    repos.dineInOrders as unknown as MemoryDineInOrderRepository,
    repos.serviceRequests as unknown as MemoryServiceRequestRepository,
    repos.sessionBills as unknown as MemorySessionBillRepository,
    board,
  );
  return { repos, reader, board };
}

function seedBillable(
  repos: DineInTransactionRepos,
  sessionId: string,
  tableId: string,
  billId: string,
  requestId: string,
  status: ServiceRequestStatus,
  sessionCreatedAt: string,
  billRequestedAt: string,
) {
  (repos.restaurantTables as unknown as {
    _seed(t: RestaurantTableDTO): RestaurantTableDTO;
  })._seed(makeTable(tableId, REST_ID, `T-${tableId}`));
  (repos.diningSessions as unknown as {
    _seed(s: DiningSessionDTO): DiningSessionDTO;
  })._seed(
    makeSession(sessionId, REST_ID, tableId, "BILL_REQUESTED", sessionCreatedAt, billRequestedAt),
  );
  (repos.serviceRequests as unknown as {
    _seed(r: ServiceRequestDTO): ServiceRequestDTO;
  })._seed(makeBringBill(requestId, sessionId, REST_ID, status, billRequestedAt));
  (repos.sessionBills as unknown as {
    _seed(b: SessionBillDTO): SessionBillDTO;
  })._seed(makeBill(billId, sessionId, REST_ID, billRequestedAt));
}

describe("Dine-In bill read repository (DINE-OPS4-B1, memory)", () => {
  describe("getAccessContextByBillId (invariant-free discovery)", () => {
    it("returns bill_id/session_id/restaurant_id for a bill row and null when missing", async () => {
      const { repos, reader } = buildReader();
      expect(await reader.getAccessContextByBillId(BILL_1)).toBeNull();

      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      expect(await reader.getAccessContextByBillId(BILL_1)).toEqual({
        bill_id: BILL_1,
        session_id: SESSION_1,
        restaurant_id: REST_ID,
      });
    });

    it("is invariant-free: a corrupted BILL_REQUESTED session still yields a context", async () => {
      const { repos, reader } = buildReader();
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_1, REST_ID, "T1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
      );
      // No BRING_BILL artifact (NONE) — discovery must still succeed so the
      // route can 404/403 before any invariant 500 could leak.
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

      expect(await reader.getAccessContextByBillId(BILL_1)).toEqual({
        bill_id: BILL_1,
        session_id: SESSION_1,
        restaurant_id: REST_ID,
      });
    });
  });

  describe("getPendingQueueByRestaurant", () => {
    it("returns only BILL_REQUESTED + BRING_BILL PENDING/ACK, ordered bill_requested_at ASC then bill.id ASC", async () => {
      const { repos, reader } = buildReader();
      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "ACKNOWLEDGED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      seedBillable(repos, SESSION_2, TABLE_2, BILL_2, REQ_2, "PENDING", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z");

      const queue = await reader.getPendingQueueByRestaurant(REST_ID);
      expect(queue.map((r) => r.bill.id)).toEqual([BILL_2, BILL_1]);
      expect(queue.map((r) => r.bring_bill_request.id)).toEqual([REQ_2, REQ_1]);
      expect(queue.map((r) => r.bring_bill_request.status)).toEqual(["PENDING", "ACKNOWLEDGED"]);
      // Session/table/bill wire fields (opened_at = session.created_at).
      expect(queue[0]!.session).toEqual({
        id: SESSION_2,
        status: "BILL_REQUESTED",
        bill_requested_at: "2026-08-24T10:00:00.000Z",
        opened_at: "2026-08-24T09:40:00.000Z",
      });
      expect(queue[0]!.table).toEqual({ id: TABLE_2, label: `T-${TABLE_2}` });
      expect(queue[0]!.bill).toEqual({
        id: BILL_2,
        session_id: SESSION_2,
        restaurant_id: REST_ID,
        food_subtotal: 200,
        packaging_fee: 0,
        gst_food: 10,
        gst_packaging: 0,
        total_amount: 210,
        frozen_at: "2026-08-24T10:00:00.000Z",
      });
    });

    it("excludes COMPLETED/delivered, cross-restaurant and non-BILL_REQUESTED sessions", async () => {
      const { repos, reader } = buildReader();
      // Delivered (COMPLETED) under a still-BILL_REQUESTED session -> excluded.
      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "COMPLETED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      // Cross-restaurant actionable row -> excluded.
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_2, GREEN_BOWL_ID, "G1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_2, GREEN_BOWL_ID, TABLE_2, "BILL_REQUESTED", "2026-08-24T09:00:00.000Z", "2026-08-24T09:05:00.000Z"),
      );
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill(REQ_2, SESSION_2, GREEN_BOWL_ID, "PENDING", "2026-08-24T09:05:00.000Z"));
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_2, SESSION_2, GREEN_BOWL_ID, "2026-08-24T09:05:00.000Z"));

      // PENDING BRING_BILL on a session that left BILL_REQUESTED -> excluded.
      const openId = "70000000-0000-4000-8000-000000000001";
      const tableOpen = "30000000-0000-4000-8000-000000000001";
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(tableOpen, REST_ID, "T3"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(openId, REST_ID, tableOpen, "OPEN", "2026-08-24T09:00:00.000Z", null),
      );
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill("b5000000-0000-4000-8000-000000000001", openId, REST_ID, "PENDING", "2026-08-24T09:05:00.000Z"));

      const queue = await reader.getPendingQueueByRestaurant(REST_ID);
      expect(queue).toEqual([]);
    });
  });

  describe("getBillDetailByBillId (post-auth)", () => {
    it("returns the full frozen detail with zone, orders excluding CANCELLED, and the PENDING request", async () => {
      const { repos, reader, board } = buildReader();
      board._seedZone(makeZone(ZONE_1, REST_ID, "Main Hall"));
      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      (repos.dineInOrders as unknown as {
        _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
      })._seed(makeOrder("o1", SESSION_1, REST_ID, "SERVED", "2026-08-24T10:00:00.000Z"));
      (repos.dineInOrders as unknown as {
        _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
      })._seed(makeOrder("o2", SESSION_1, REST_ID, "CANCELLED", "2026-08-24T10:00:30.000Z"));

      const detail = await reader.getBillDetailByBillId(BILL_1);
      expect(detail).not.toBeNull();
      expect(detail!.session.status).toBe("BILL_REQUESTED");
      expect(detail!.table).toEqual({ id: TABLE_1, label: `T-${TABLE_1}` });
      expect(detail!.zone).toEqual({ id: ZONE_1, name: "Main Hall" });
      expect(detail!.bring_bill_request).toEqual({
        id: REQ_1,
        status: "PENDING",
        acknowledged_at: null,
        completed_at: null,
      });
      expect(detail!.orders.map((o) => o.id)).toEqual(["o1"]);
      expect(detail!.orders[0]!.items).toEqual([
        { name: "Paneer Tikka", quantity: 2, item_subtotal: 200 },
      ]);
      // Zone is null when the table has none / it does not resolve.
      const otherId = "90000000-0000-4000-8000-000000000001";
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(otherId, REST_ID, TABLE_2, "BILL_REQUESTED", "2026-08-24T09:30:00.000Z", "2026-08-24T09:55:00.000Z"),
      );
      expect((await reader.getBillDetailByBillId(BILL_2))).toBeNull();
    });

    it("keeps a delivered (COMPLETED) bill readable", async () => {
      const { repos, reader } = buildReader();
      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "COMPLETED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      const detail = await reader.getBillDetailByBillId(BILL_1);
      expect(detail!.bring_bill_request).toEqual({
        id: REQ_1,
        status: "COMPLETED",
        acknowledged_at: "2026-08-24T10:05:00.000Z",
        completed_at: "2026-08-24T10:06:00.000Z",
      });
    });

    it("throws BILL_INVARIANT_VIOLATION under BILL_REQUESTED for NONE and MULTIPLE artifacts", async () => {
      const { repos, reader } = buildReader();
      // NONE.
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_1, REST_ID, "T1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

      await expect(reader.getBillDetailByBillId(BILL_1)).rejects.toMatchObject({
        code: "BILL_INVARIANT_VIOLATION",
        status: 500,
      });

      // MULTIPLE.
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_2, REST_ID, "T2"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_2, REST_ID, TABLE_2, "BILL_REQUESTED", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_2, SESSION_2, REST_ID, "2026-08-24T10:00:00.000Z"));
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill(REQ_1, SESSION_2, REST_ID, "PENDING", "2026-08-24T10:00:00.000Z"));
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill(REQ_2, SESSION_2, REST_ID, "ACKNOWLEDGED", "2026-08-24T10:00:01.000Z"));

      await expect(reader.getBillDetailByBillId(BILL_2)).rejects.toMatchObject({
        code: "BILL_INVARIANT_VIOLATION",
        status: 500,
      });
    });

    it("does NOT enforce the invariant outside BILL_REQUESTED (detail truthful, artifact null)", async () => {
      const { repos, reader } = buildReader();
      // CLOSED session with a frozen bill and NO bring-bill artifact.
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_1, REST_ID, "T1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_1, REST_ID, TABLE_1, "CLOSED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

      const detail = await reader.getBillDetailByBillId(BILL_1);
      expect(detail!.session.status).toBe("CLOSED");
      expect(detail!.bring_bill_request).toBeNull();
    });
  });

  describe("getBillActionContextByBillId (post-auth)", () => {
    it("returns session status + the BRING_BILL artifact under a healthy BILL_REQUESTED", async () => {
      const { repos, reader } = buildReader();
      seedBillable(repos, SESSION_1, TABLE_1, BILL_1, REQ_1, "ACKNOWLEDGED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z");
      expect(await reader.getBillActionContextByBillId(BILL_1)).toEqual({
        session: { id: SESSION_1, status: "BILL_REQUESTED" },
        bring_bill_request: { id: REQ_1, status: "ACKNOWLEDGED" },
      });
    });

    it("throws BILL_INVARIANT_VIOLATION under BILL_REQUESTED for NONE and MULTIPLE artifacts", async () => {
      const { repos, reader } = buildReader();
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_1, REST_ID, "T1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_1, REST_ID, TABLE_1, "BILL_REQUESTED", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));
      await expect(reader.getBillActionContextByBillId(BILL_1)).rejects.toMatchObject({
        code: "BILL_INVARIANT_VIOLATION",
      });

      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_2, REST_ID, "T2"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_2, REST_ID, TABLE_2, "BILL_REQUESTED", "2026-08-24T09:40:00.000Z", "2026-08-24T10:00:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_2, SESSION_2, REST_ID, "2026-08-24T10:00:00.000Z"));
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill(REQ_1, SESSION_2, REST_ID, "PENDING", "2026-08-24T10:00:00.000Z"));
      (repos.serviceRequests as unknown as {
        _seed(r: ServiceRequestDTO): ServiceRequestDTO;
      })._seed(makeBringBill(REQ_2, SESSION_2, REST_ID, "ACKNOWLEDGED", "2026-08-24T10:00:01.000Z"));
      await expect(reader.getBillActionContextByBillId(BILL_2)).rejects.toMatchObject({
        code: "BILL_INVARIANT_VIOLATION",
      });
    });

    it("truthfully reports a non-BILL_REQUESTED session with a null artifact (no invariant)", async () => {
      const { repos, reader } = buildReader();
      (repos.restaurantTables as unknown as {
        _seed(t: RestaurantTableDTO): RestaurantTableDTO;
      })._seed(makeTable(TABLE_1, REST_ID, "T1"));
      (repos.diningSessions as unknown as {
        _seed(s: DiningSessionDTO): DiningSessionDTO;
      })._seed(
        makeSession(SESSION_1, REST_ID, TABLE_1, "PAYMENT_PENDING", "2026-08-24T09:50:00.000Z", "2026-08-24T10:01:00.000Z"),
      );
      (repos.sessionBills as unknown as {
        _seed(b: SessionBillDTO): SessionBillDTO;
      })._seed(makeBill(BILL_1, SESSION_1, REST_ID, "2026-08-24T10:01:00.000Z"));

      expect(await reader.getBillActionContextByBillId(BILL_1)).toEqual({
        session: { id: SESSION_1, status: "PAYMENT_PENDING" },
        bring_bill_request: null,
      });
    });

    it("returns null when the bill does not exist", async () => {
      const { repos, reader } = buildReader();
      void repos;
      expect(await reader.getBillActionContextByBillId(BILL_1)).toBeNull();
    });
  });
});
