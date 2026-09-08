import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
  ServiceRequestType,
} from "@snakzap/types";
import type {
  ServiceRequestDTO,
  VendorTableBoardRow,
} from "../repositories/dineInContracts";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import { AppError } from "../middleware/envelope";
import {
  getDineInSessionReadRepository,
  getDineInTableBoardReadRepository,
  getDineInOrderReadRepository,
  getDineInServiceRequestReadRepository,
  getDineInBillReadRepository,
} from "../repositories/dineInComposition";
import { getCatalogRepository } from "../routes/catalog";

// ============================================================
// Admin Dine-In read-only service (ADMIN-OPS1-A2).
//
// Live-operations oversight across ALL restaurants — it NEVER performs a
// mutation: no SR acknowledge, no bill delivery, no order advance/cancel, no
// session close, no table/session/bill write, no payment/settlement action.
// Every response is built by EXPLICIT DTO mapping from existing read
// repositories (session read accessor + table board + orders + service
// requests + frozen bill read); sensitive fields are never copied.
//
// Live scope is exactly OPEN | ACTIVE | BILL_REQUESTED | PAYMENT_PENDING.
// CLOSED is excluded from list/overview and a known CLOSED (or unknown)
// session detail is a 404 — this is live-ops, not historical archive.
// Bill status derives ONLY from the BRING_BILL artifact lifecycle
// (NONE/REQUESTED/ACKNOWLEDGED/DELIVERED); PAYMENT_PENDING is a dining-session
// status only, and no PAID/SETTLED/PAYMENT_SUCCESS/CLOSED state is fabricated.
// ============================================================

const LIVE_SESSION_STATUSES: readonly DiningSessionStatus[] = [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
];
const LIVE_STATUS_SET = new Set<string>(LIVE_SESSION_STATUSES);

// BRING_BILL artifact statuses that surface on the wire. CANCELLED is never
// surfaced (the billing flow owns BRING_BILL cancellation) and maps to NONE.
const BRING_BILL_RANK: Record<string, number> = {
  PENDING: 1,
  ACKNOWLEDGED: 2,
  COMPLETED: 3,
};

export type AdminDineInLiveSessionStatus =
  | "OPEN"
  | "ACTIVE"
  | "BILL_REQUESTED"
  | "PAYMENT_PENDING";

export type AdminDineInBillStatus =
  | "NONE"
  | "REQUESTED"
  | "ACKNOWLEDGED"
  | "DELIVERED";

export type AdminDineInSessionSort = "opened_at" | "updated_at" | "table_label";
export type AdminDineInSessionOrder = "asc" | "desc";

export interface AdminDineInOverviewRestaurant {
  restaurant_id: string;
  restaurant_name: string;
  active_sessions: number;
  bill_requested_sessions: number;
  pending_service_requests: number;
}

export interface AdminDineInOverview {
  totals: {
    restaurants: number;
    active_sessions: number;
    bill_requested_sessions: number;
    pending_service_requests: number;
  };
  by_restaurant: AdminDineInOverviewRestaurant[];
  generated_at: string;
}

export interface AdminDineInSessionRow {
  session_id: string;
  restaurant_id: string;
  restaurant_name: string;
  table_id: string;
  table_label: string;
  zone_name: string | null;
  status: AdminDineInLiveSessionStatus;
  order_count: number;
  pending_service_request_count: number;
  bill_status: AdminDineInBillStatus;
  opened_at: string;
  updated_at: string;
}

export interface AdminDineInSessionListParams {
  restaurant_id?: string;
  status?: AdminDineInLiveSessionStatus;
  zone_id?: string;
  sort?: AdminDineInSessionSort;
  order?: AdminDineInSessionOrder;
  page?: number;
  limit?: number;
}

export interface AdminDineInSessionList {
  items: AdminDineInSessionRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface AdminDineInFrozenBillTotals {
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  total_amount: number;
  frozen_at: string;
}

export interface AdminDineInBillSection {
  status: AdminDineInBillStatus;
  requested_at: string | null;
  acknowledged_at: string | null;
  delivered_at: string | null;
  totals: AdminDineInFrozenBillTotals | null;
}

export interface AdminDineInSessionDetailOrderItem {
  name: string;
  quantity: number;
  item_subtotal: number;
}

export interface AdminDineInSessionDetailOrder {
  id: string;
  status: DineInOrderStatus;
  total_amount: number;
  created_at: string;
  items: AdminDineInSessionDetailOrderItem[];
}

export interface AdminDineInSessionDetailRequest {
  id: string;
  request_type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  created_at: string;
  acknowledged_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface AdminDineInSessionDetail {
  session: {
    session_id: string;
    status: AdminDineInLiveSessionStatus;
    opened_at: string;
    updated_at: string;
    bill_requested_at: string | null;
    payment_pending_at: string | null;
  };
  restaurant: {
    restaurant_id: string;
    restaurant_name: string;
  };
  table: {
    table_id: string;
    table_label: string;
    seat_count: number | null;
  };
  zone: { zone_id: string; zone_name: string } | null;
  orders: AdminDineInSessionDetailOrder[];
  service_requests: AdminDineInSessionDetailRequest[];
  bill: AdminDineInBillSection;
}

interface Anchor {
  restaurant: RestaurantDTO;
  row: VendorTableBoardRow;
}

function isLiveSession(
  status: DiningSessionStatus,
): status is AdminDineInLiveSessionStatus {
  return LIVE_STATUS_SET.has(status);
}

function isPendingRequestStatus(status: ServiceRequestStatus): boolean {
  return status === "PENDING" || status === "ACKNOWLEDGED";
}

// PENDING + ACKNOWLEDGED non-BRING_BILL service requests (mirrors the table
// board's open_request_count semantics — the billing flow owns BRING_BILL).
function pendingServiceRequestCount(requests: ServiceRequestDTO[]): number {
  let count = 0;
  for (const request of requests) {
    if (request.request_type === "BRING_BILL") continue;
    if (isPendingRequestStatus(request.status)) count += 1;
  }
  return count;
}

// Single visible BRING_BILL artifact for a session. Healthy sessions carry at
// most one; defensively pick the highest lifecycle rank (COMPLETED >
// ACKNOWLEDGED > PENDING), then the earliest created_at, then id asc so a
// corrupted MULTIPLE can never flip the derived bill status non-deterministically.
function pickBringBill(requests: ServiceRequestDTO[]): ServiceRequestDTO | null {
  const visible = requests.filter(
    (request) =>
      request.request_type === "BRING_BILL" &&
      BRING_BILL_RANK[request.status] !== undefined,
  );
  if (visible.length === 0) return null;
  const best = [...visible].sort((a, b) => {
    const rankDiff = BRING_BILL_RANK[b.status]! - BRING_BILL_RANK[a.status]!;
    if (rankDiff !== 0) return rankDiff;
    const timeDiff = Date.parse(a.created_at) - Date.parse(b.created_at);
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  })[0]!;
  return best;
}

function billStatusOf(status: ServiceRequestStatus): AdminDineInBillStatus {
  switch (status) {
    case "PENDING":
      return "REQUESTED";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "COMPLETED":
      return "DELIVERED";
    default:
      // CANCELLED artifacts never surface: no BRING_BILL -> NONE.
      return "NONE";
  }
}

function billStatusOfRequests(requests: ServiceRequestDTO[]): AdminDineInBillStatus {
  const bringBill = pickBringBill(requests);
  return bringBill ? billStatusOf(bringBill.status) : "NONE";
}

function frozenBillSection(
  requests: ServiceRequestDTO[],
  frozenBill: {
    food_subtotal: number;
    packaging_fee: number;
    gst_food: number;
    gst_packaging: number;
    total_amount: number;
    frozen_at: string;
  } | null,
): AdminDineInBillSection {
  const bringBill = pickBringBill(requests);
  if (!bringBill) {
    return {
      status: "NONE",
      requested_at: null,
      acknowledged_at: null,
      delivered_at: null,
      totals: frozenBill ? mapFrozenBillTotals(frozenBill) : null,
    };
  }
  return {
    status: billStatusOf(bringBill.status),
    requested_at: bringBill.created_at,
    acknowledged_at:
      bringBill.status === "ACKNOWLEDGED" || bringBill.status === "COMPLETED"
        ? bringBill.acknowledged_at
        : null,
    delivered_at: bringBill.status === "COMPLETED" ? bringBill.completed_at : null,
    totals: frozenBill ? mapFrozenBillTotals(frozenBill) : null,
  };
}

function mapFrozenBillTotals(frozenBill: {
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  total_amount: number;
  frozen_at: string;
}): AdminDineInFrozenBillTotals {
  return {
    food_subtotal: frozenBill.food_subtotal,
    packaging_fee: frozenBill.packaging_fee,
    gst_food: frozenBill.gst_food,
    gst_packaging: frozenBill.gst_packaging,
    total_amount: frozenBill.total_amount,
    frozen_at: frozenBill.frozen_at,
  };
}

export class AdminDineInReadService {
  async getOverview(): Promise<AdminDineInOverview> {
    const catalog = getCatalogRepository();
    const board = getDineInTableBoardReadRepository();
    const restaurants = await catalog.getAllRestaurants();

    // Bounded cross-restaurant composition: one board read per restaurant in
    // parallel (Promise.all), never an uncontrolled per-session chain.
    const perRestaurant = await Promise.all(
      restaurants.map(async (restaurant) => {
        const rows = await board.getByRestaurant(restaurant.id);
        let activeSessions = 0;
        let billRequestedSessions = 0;
        let pendingServiceRequests = 0;
        for (const row of rows) {
          if (!row.session || !isLiveSession(row.session.status)) continue;
          activeSessions += 1;
          if (row.session.status === "BILL_REQUESTED") billRequestedSessions += 1;
          pendingServiceRequests += row.open_request_count;
        }
        return {
          restaurant_id: restaurant.id,
          restaurant_name: restaurant.name,
          active_sessions: activeSessions,
          bill_requested_sessions: billRequestedSessions,
          pending_service_requests: pendingServiceRequests,
        };
      }),
    );

    // Freeze "restaurants" as the distinct restaurants having at least one live
    // Dine-In session (inactive / no-live restaurants are excluded from the
    // list while remaining discoverable on the per-restaurant board when live).
    const liveRestaurants = perRestaurant.filter(
      (restaurant) => restaurant.active_sessions > 0,
    );
    return {
      totals: {
        restaurants: liveRestaurants.length,
        active_sessions: perRestaurant.reduce(
          (total, restaurant) => total + restaurant.active_sessions,
          0,
        ),
        bill_requested_sessions: perRestaurant.reduce(
          (total, restaurant) => total + restaurant.bill_requested_sessions,
          0,
        ),
        pending_service_requests: perRestaurant.reduce(
          (total, restaurant) => total + restaurant.pending_service_requests,
          0,
        ),
      },
      by_restaurant: liveRestaurants,
      generated_at: new Date().toISOString(),
    };
  }

  async listSessions(params: AdminDineInSessionListParams): Promise<AdminDineInSessionList> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const sort = params.sort ?? "opened_at";
    const order = params.order ?? "desc";

    const anchors = await this.enumerateLiveAnchors(params.restaurant_id);

    // Early narrow by the stable board snapshot before any child read.
    const candidates = anchors.filter((anchor) => {
      const session = anchor.row.session!;
      if (params.status && session.status !== params.status) return false;
      if (params.zone_id && anchor.row.zone?.id !== params.zone_id) return false;
      return true;
    });

    // One session/order/request read triple per live session, all in parallel.
    const rows = (
      await Promise.all(candidates.map((anchor) => this.buildSessionRow(anchor)))
    ).filter((row): row is AdminDineInSessionRow => row !== null);

    // Authoritative re-check against the freshly-read session.status so a
    // between-reads status change can never leak a non-matching live row.
    const filtered = params.status
      ? rows.filter((row) => row.status === params.status)
      : rows;

    this.sortRows(filtered, sort, order);
    const total = filtered.length;
    const start = (page - 1) * limit;
    return {
      items: filtered.slice(start, start + limit),
      pagination: { page, limit, total },
    };
  }

  async getSessionDetail(sessionId: string): Promise<AdminDineInSessionDetail> {
    const sessionRead = getDineInSessionReadRepository();
    const session = await sessionRead.getById(sessionId);
    if (!session) {
      throw new AppError("NOT_FOUND", "Dine-in session not found", 404);
    }
    if (!isLiveSession(session.status)) {
      // Known CLOSED/terminal session: live-operations endpoint, not archive.
      throw new AppError("NOT_FOUND", "Dine-in session not found", 404);
    }

    const board = getDineInTableBoardReadRepository();
    const boardRows = await board.getByRestaurant(session.restaurant_id);
    const anchor = boardRows.find((row) => row.session?.id === sessionId) ?? null;
    if (!anchor) {
      // Fail closed on a race (session closed between read and board lookup)
      // instead of surfacing a half-mapped 500.
      const latest = await sessionRead.getById(sessionId);
      if (!latest || !isLiveSession(latest.status)) {
        throw new AppError("NOT_FOUND", "Dine-in session not found", 404);
      }
      throw new AppError(
        "INTERNAL_ERROR",
        "Live dine-in session missing from the table board",
        500,
      );
    }

    const catalog = getCatalogRepository();
    const restaurant = await catalog.getRestaurantById(session.restaurant_id);
    if (!restaurant) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Dine-in session restaurant not found",
        500,
      );
    }

    const orderRepo = getDineInOrderReadRepository();
    const requestRepo = getDineInServiceRequestReadRepository();
    const [orders, requests, frozenBill] = await Promise.all([
      orderRepo.getBySessionWithItems(sessionId),
      requestRepo.getBySession(sessionId),
      getDineInBillReadRepository().getFrozenBillBySessionId(sessionId),
    ]);

    const sortedOrders = [...orders].sort(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        a.id.localeCompare(b.id),
    );
    const sortedRequests = [...requests].sort(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        a.id.localeCompare(b.id),
    );

    return {
      session: {
        session_id: session.id,
        status: session.status,
        opened_at: session.created_at,
        updated_at: session.updated_at,
        bill_requested_at: session.bill_requested_at,
        payment_pending_at: session.payment_pending_at,
      },
      restaurant: {
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name,
      },
      table: {
        table_id: anchor.table.id,
        table_label: anchor.table.label,
        seat_count: anchor.table.seat_count,
      },
      zone: anchor.zone
        ? { zone_id: anchor.zone.id, zone_name: anchor.zone.name }
        : null,
      orders: sortedOrders.map((order) => ({
        id: order.id,
        status: order.status,
        total_amount: order.total_amount,
        created_at: order.created_at,
        items: order.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          item_subtotal: item.item_subtotal,
        })),
      })),
      service_requests: sortedRequests.map((request) => ({
        id: request.id,
        request_type: request.request_type,
        status: request.status,
        note: request.note,
        created_at: request.created_at,
        acknowledged_at: request.acknowledged_at,
        completed_at: request.completed_at,
        cancelled_at: request.cancelled_at,
      })),
      bill: frozenBillSection(requests, frozenBill),
    };
  }

  // ---------------------------------------------------------------------
  // Private helpers (read-model composition only — no mutation anywhere).
  // ---------------------------------------------------------------------

  // Enumerate the live anchors (restaurant x live board row) for all
  // restaurants, or for a single restaurant when filtered. Bounded: exactly
  // one board read per enumerated restaurant, in parallel.
  private async enumerateLiveAnchors(
    restaurantId?: string,
  ): Promise<Anchor[]> {
    const catalog = getCatalogRepository();
    let restaurants = await catalog.getAllRestaurants();
    if (restaurantId) {
      restaurants = restaurants.filter((restaurant) => restaurant.id === restaurantId);
    }
    const board = getDineInTableBoardReadRepository();
    const perRestaurant = await Promise.all(
      restaurants.map(async (restaurant) => {
        const rows = await board.getByRestaurant(restaurant.id);
        return rows
          .filter((row) => row.session && isLiveSession(row.session.status))
          .map((row) => ({ restaurant, row }));
      }),
    );
    const anchors: Anchor[] = [];
    for (const group of perRestaurant) anchors.push(...group);
    return anchors;
  }

  private async buildSessionRow(
    anchor: Anchor,
  ): Promise<AdminDineInSessionRow | null> {
    const sessionId = anchor.row.session!.id;
    const sessionRead = getDineInSessionReadRepository();
    const [session, orders, requests] = await Promise.all([
      sessionRead.getById(sessionId),
      getDineInOrderReadRepository().getBySession(sessionId),
      getDineInServiceRequestReadRepository().getBySession(sessionId),
    ]);
    // Authoritative re-check: the row is dropped when the session is gone, no
    // longer live, or (defensive, mirrors the board's restaurant scope guard)
    // not owned by the enumerated restaurant — never surfaced stale.
    if (
      !session ||
      !isLiveSession(session.status) ||
      session.restaurant_id !== anchor.restaurant.id
    ) {
      return null;
    }
    return {
      session_id: session.id,
      restaurant_id: session.restaurant_id,
      restaurant_name: anchor.restaurant.name,
      table_id: anchor.row.table.id,
      table_label: anchor.row.table.label,
      zone_name: anchor.row.zone?.name ?? null,
      status: session.status,
      order_count: orders.length,
      pending_service_request_count: pendingServiceRequestCount(requests),
      bill_status: billStatusOfRequests(requests),
      opened_at: session.created_at,
      updated_at: session.updated_at,
    };
  }

  private sortRows(
    rows: AdminDineInSessionRow[],
    sort: AdminDineInSessionSort,
    order: AdminDineInSessionOrder,
  ): void {
    const direction = order === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      if (sort === "opened_at") {
        cmp = Date.parse(a.opened_at) - Date.parse(b.opened_at);
      } else if (sort === "updated_at") {
        cmp = Date.parse(a.updated_at) - Date.parse(b.updated_at);
      } else {
        cmp = a.table_label.localeCompare(b.table_label);
      }
      if (cmp !== 0) return cmp * direction;
      // Deterministic tie-break is ALWAYS session_id asc, regardless of order.
      return a.session_id.localeCompare(b.session_id);
    });
  }
}

export const adminDineInReadService = new AdminDineInReadService();
