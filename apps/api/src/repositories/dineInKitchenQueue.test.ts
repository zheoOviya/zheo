import { beforeEach, describe, expect, it } from "vitest";
import type {
  DineInOrderWithItemsDTO,
  DineInTransactionRepos,
  DiningSessionDTO,
  RestaurantTableDTO,
} from "./dineInContracts";
import { buildMemoryDineInRepos } from "./dineInMemoryRepositories";

// ------------------------------------------------------------
// DINE-OPS1.2 kitchen-queue read model (memory repository).
//
// Pure repository-level tests: the memory order repo derives table/session
// from the shared memory universe (buildMemoryDineInRepos wires sessions +
// tables into the order repo), never from the caller.
// ------------------------------------------------------------

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL_ID = "a0000000-0000-4000-8000-000000000002";

function makeTable(
  id: string,
  restaurantId: string,
  label: string,
): RestaurantTableDTO {
  return {
    id,
    restaurant_id: restaurantId,
    zone_id: null,
    label,
    table_token: `token-${id}`,
    seat_count: 4,
    is_active: true,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  };
}

function makeSession(
  id: string,
  restaurantId: string,
  tableId: string,
  createdAt: string,
): DiningSessionDTO {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: tableId,
    owner_user_id: "u00000000-0000-4000-8000-000000000001",
    status: "OPEN",
    bill_requested_at: null,
    payment_pending_at: null,
    closed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeOrder(
  id: string,
  restaurantId: string,
  sessionId: string,
  createdAt: string,
  status: DineInOrderWithItemsDTO["status"],
): DineInOrderWithItemsDTO {
  return {
    id,
    session_id: sessionId,
    restaurant_id: restaurantId,
    placed_by: "u00000000-0000-4000-8000-000000000001",
    status,
    total_amount: 462,
    notes: null,
    served_at: null,
    cancelled_at: null,
    cancelled_by: null,
    created_at: createdAt,
    updated_at: createdAt,
    items: [
      {
        id: `itm-${id}`,
        dine_in_order_id: id,
        restaurant_id: restaurantId,
        menu_item_id: "b0000000-0000-4000-8000-000000000001",
        name: "Chicken Biryani",
        base_price: 220,
        quantity: 2,
        customizations: [],
        customization_total: 0,
        item_subtotal: 440,
        created_at: createdAt,
      },
    ],
  };
}

describe("MemoryDineInOrderRepository.getKitchenQueueByRestaurant (DINE-OPS1.2)", () => {
  let repos: DineInTransactionRepos;

  beforeEach(() => {
    repos = buildMemoryDineInRepos();
  });

  function seedTable(t: RestaurantTableDTO) {
    (repos.restaurantTables as unknown as {
      _seed(t: RestaurantTableDTO): RestaurantTableDTO;
    })._seed(t);
  }

  function seedSession(s: DiningSessionDTO) {
    (repos.diningSessions as unknown as {
      _seed(s: DiningSessionDTO): DiningSessionDTO;
    })._seed(s);
  }

  function seedOrder(o: DineInOrderWithItemsDTO) {
    (repos.dineInOrders as unknown as {
      _seed(o: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO;
    })._seed(o);
  }

  it("includes only actionable statuses (PLACED/PREPARING/READY_TO_SERVE), oldest first", async () => {
    seedTable(makeTable("t1", REST_ID, "T1"));
    seedTable(makeTable("t2", REST_ID, "T2"));
    seedSession(makeSession("s1", REST_ID, "t1", "2026-08-24T10:00:00.000Z"));
    seedSession(makeSession("s2", REST_ID, "t2", "2026-08-24T10:05:00.000Z"));

    seedOrder(makeOrder("o-new", REST_ID, "s2", "2026-08-24T10:06:00.000Z", "PLACED"));
    seedOrder(makeOrder("o-old", REST_ID, "s1", "2026-08-24T10:01:00.000Z", "PREPARING"));
    seedOrder(makeOrder("o-ready", REST_ID, "s1", "2026-08-24T10:02:00.000Z", "READY_TO_SERVE"));
    seedOrder(makeOrder("o-served", REST_ID, "s1", "2026-08-24T10:00:00.000Z", "SERVED"));
    seedOrder(makeOrder("o-cancelled", REST_ID, "s1", "2026-08-24T10:00:30.000Z", "CANCELLED"));

    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);

    expect(queue.map((o) => o.id)).toEqual(["o-old", "o-ready", "o-new"]);
    for (const order of queue) {
      expect(["PLACED", "PREPARING", "READY_TO_SERVE"]).toContain(order.status);
    }
  });

  it("excludes SERVED and CANCELLED orders", async () => {
    seedTable(makeTable("t1", REST_ID, "T1"));
    seedSession(makeSession("s1", REST_ID, "t1", "2026-08-24T10:00:00.000Z"));
    seedOrder(makeOrder("o-served", REST_ID, "s1", "2026-08-24T10:00:00.000Z", "SERVED"));
    seedOrder(makeOrder("o-cancelled", REST_ID, "s1", "2026-08-24T10:00:30.000Z", "CANCELLED"));

    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);
    expect(queue).toEqual([]);
  });

  it("derives table id/label from the session/table store, never caller input", async () => {
    seedTable(makeTable("t-7", REST_ID, "Table 7"));
    seedSession(makeSession("s1", REST_ID, "t-7", "2026-08-24T10:00:00.000Z"));
    seedOrder(makeOrder("o1", REST_ID, "s1", "2026-08-24T10:00:00.000Z", "PLACED"));

    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);
    expect(queue).toHaveLength(1);
    const order = queue[0]!;
    expect(order.table).toEqual({ id: "t-7", label: "Table 7" });
    expect(order.session_id).toBe("s1");
    expect(order.id).toBe("o1");
  });

  it("carries persisted item name/quantity/subtotal snapshot", async () => {
    seedTable(makeTable("t1", REST_ID, "T1"));
    seedSession(makeSession("s1", REST_ID, "t1", "2026-08-24T10:00:00.000Z"));
    seedOrder(makeOrder("o1", REST_ID, "s1", "2026-08-24T10:00:00.000Z", "PLACED"));

    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);
    const order = queue[0]!;
    expect(order.items).toEqual([
      {
        menu_item_id: "b0000000-0000-4000-8000-000000000001",
        name: "Chicken Biryani",
        quantity: 2,
        item_subtotal: 440,
      },
    ]);
    expect(order.total_amount).toBe(462);
    expect(order.created_at).toBe("2026-08-24T10:00:00.000Z");
  });

  it("scopes to the requested restaurant (zero cross-restaurant leakage)", async () => {
    seedTable(makeTable("t1", REST_ID, "T1"));
    seedTable(makeTable("tg1", GREEN_BOWL_ID, "G1"));
    seedSession(makeSession("s1", REST_ID, "t1", "2026-08-24T10:00:00.000Z"));
    seedSession(makeSession("sg1", GREEN_BOWL_ID, "tg1", "2026-08-24T10:00:00.000Z"));
    seedOrder(makeOrder("o1", REST_ID, "s1", "2026-08-24T10:00:00.000Z", "PLACED"));
    seedOrder(makeOrder("g1", GREEN_BOWL_ID, "sg1", "2026-08-24T10:00:00.000Z", "PLACED"));

    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);
    expect(queue.map((o) => o.id)).toEqual(["o1"]);
  });

  it("returns an empty array for a restaurant with no orders", async () => {
    const queue = await repos.dineInOrders.getKitchenQueueByRestaurant(REST_ID);
    expect(queue).toEqual([]);
  });
});
