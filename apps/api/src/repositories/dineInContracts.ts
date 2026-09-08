import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
  ServiceRequestType,
  StaffAssignmentStatus,
} from "@snakzap/types";
import type { DrizzleDb } from "../lib/dbType";

// ============================================
// Dine-In / Smart Table Ordering persistence contracts.
// Interfaces + DTO/result types only. No business logic.
//
// Frozen source contracts:
//   D2.4A repository boundaries (no generic CRUD, no delete, no generic
//   status setter), D2.4C eligibility reader, D2.4B/D2.4G tx-bound
//   transaction port, D2.4H2 locking primitives, D2.4F service-request
//   transitions.
//
// Transactional variants expose row-lock primitives; plain variants are the
// non-transactional (or child-read) surface. All DineInTransactionRepos
// members are constructed per transaction from the tx handle — never shared
// globals. sessionBills is additionally branded so it can only be produced
// through the tx-bound construction path.
// ============================================

// ------------------------------------------------------------
// Shared result contracts (frozen D2.4A / D2.4F).
// ------------------------------------------------------------

export type TransitionResult<T, S> =
  | { kind: "UPDATED"; value: T }
  | { kind: "NOT_FOUND" }
  | { kind: "STATE_MISMATCH"; current: S };

export type ArtifactLookup<T> =
  | { kind: "NONE" }
  | { kind: "FOUND"; value: T }
  | { kind: "MULTIPLE"; values: T[] };

// ------------------------------------------------------------
// DTOs (frozen schema in packages/db/src/schema/dinein.ts).
// decimal DB money is normalized to number at the repository boundary.
// ------------------------------------------------------------

export interface DineZoneDTO {
  id: string;
  restaurant_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RestaurantTableDTO {
  id: string;
  restaurant_id: string;
  zone_id: string | null;
  label: string;
  table_token: string;
  seat_count: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DiningSessionDTO {
  id: string;
  restaurant_id: string;
  table_id: string;
  owner_user_id: string;
  status: DiningSessionStatus;
  bill_requested_at: string | null;
  payment_pending_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaffAssignmentDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  staff_user_id: string;
  assigned_by: string | null;
  zone_id: string | null;
  status: StaffAssignmentStatus;
  assigned_at: string;
  ended_at: string | null;
}

export interface DineInOrderItemDTO {
  id: string;
  dine_in_order_id: string;
  restaurant_id: string;
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: Array<{ name: string; price_delta: number }>;
  customization_total: number;
  item_subtotal: number;
  created_at: string;
}

export interface DineInOrderDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  placed_by: string;
  status: DineInOrderStatus;
  total_amount: number;
  notes: string | null;
  served_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DineInOrderWithItemsDTO extends DineInOrderDTO {
  items: DineInOrderItemDTO[];
}

// Kitchen queue item read model (DINE-OPS1.2). Only kitchen-useful server
// data: historical name snapshot, menu item id, quantity, and item subtotal.
// The name is a persisted snapshot on dine_in_order_items — no catalog join.
export interface DineInKitchenOrderItemDTO {
  menu_item_id: string;
  name: string;
  quantity: number;
  item_subtotal: number;
}

// Kitchen queue order read model (DINE-OPS1.2). Table identity is DERIVED
// from the repository (dining_sessions.table_id -> restaurant_tables), never
// client-supplied. Statuses are restricted to the actionable kitchen set
// (PLACED / PREPARING / READY_TO_SERVE); SERVED / CANCELLED are excluded.
export interface DineInKitchenOrderDTO {
  id: string;
  session_id: string;
  status: DineInOrderStatus;
  total_amount: number;
  created_at: string;
  table: { id: string; label: string };
  items: DineInKitchenOrderItemDTO[];
}

// Default kitchen queue statuses (DINE-OPS1.2): orders that still need
// kitchen action. SERVED and CANCELLED are terminal and excluded.
export const KITCHEN_ORDER_STATUSES: DineInOrderStatus[] = [
  "PLACED",
  "PREPARING",
  "READY_TO_SERVE",
];

// Deliberately no table_id: table identity is DERIVED via dining_sessions.
export interface ServiceRequestDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  requested_by: string;
  request_type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

// Vendor service-request operations queue item (DINE-OPS2). Only the
// actionable board fields are exposed; BRING_BILL is excluded by the query
// (the billing flow owns that artifact). Table identity is DERIVED by the
// repository (service_requests.session_id -> dining_sessions.table_id ->
// restaurant_tables), never client-supplied. Statuses are restricted to the
// actionable set (PENDING / ACKNOWLEDGED); COMPLETED / CANCELLED are excluded.
export interface ServiceRequestOperationsDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  request_type: ServiceRequestType;
  status: ServiceRequestStatus;
  note: string | null;
  created_at: string;
  table: { id: string; label: string };
}

// Vendor table/session board row (DINE-OPS3). Read-only occupancy board: one
// row per restaurant table (including disabled tables) with the server-derived
// live session (if any) and the actionable open-order / open-request counts.
// Occupancy is DERIVED from the live-session invariant (at most one live
// session per table), never stored on the table; a table may be disabled AND
// still carry a live session, and the board surfaces both facts truthfully.
// BILL_REQUESTED is carried by session.status (never by a request count);
// open_request_count intentionally excludes BRING_BILL (the billing flow owns
// that artifact). No owner/customer identity and no table_token are exposed.
export interface VendorTableBoardRow {
  table: {
    id: string;
    label: string;
    seat_count: number | null;
    is_active: boolean;
  };
  zone: { id: string; name: string } | null;
  session: {
    id: string;
    status: DiningSessionStatus;
    opened_at: string;
    bill_requested_at: string | null;
  } | null;
  open_order_count: number;
  open_request_count: number;
}

// Deliberately no updated_at and no payment fields: a frozen bill is
// immutable and payment state is D-PAY gated.
export interface SessionBillDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  total_amount: number;
  frozen_at: string;
  created_at: string;
}

export interface RestaurantEligibilityDTO {
  id: string;
  is_active: boolean;
}

// Public table-resolution read model (frozen UI1-A-R1). Only trusted display
// data: restaurant identity + table label + a proceed signal. The opaque
// token is never part of the DTO, and no internal/staff metadata is exposed.
export interface TableResolveDTO {
  restaurant: { id: string; name: string };
  table: { id: string; label: string };
  can_start_session: boolean;
}

// ------------------------------------------------------------
// Create inputs.
// ------------------------------------------------------------

export interface CreateDineZoneInput {
  restaurant_id: string;
  name: string;
}

export interface CreateRestaurantTableInput {
  restaurant_id: string;
  zone_id?: string | null;
  label: string;
  table_token: string;
  seat_count?: number | null;
}

export interface CreateDiningSessionInput {
  restaurant_id: string;
  table_id: string;
  owner_user_id: string;
}

export interface CreateStaffAssignmentInput {
  session_id: string;
  restaurant_id: string;
  staff_user_id: string;
  assigned_by?: string | null;
  zone_id?: string | null;
}

export interface CreateDineInOrderItemInput {
  menu_item_id: string;
  name: string;
  base_price: number;
  quantity: number;
  customizations: Array<{ name: string; price_delta: number }>;
  customization_total: number;
  item_subtotal: number;
}

export interface CreateDineInOrderInput {
  session_id: string;
  restaurant_id: string;
  placed_by: string;
  total_amount: number;
  notes?: string | null;
  items: CreateDineInOrderItemInput[];
}

export interface CreateServiceRequestInput {
  session_id: string;
  restaurant_id: string;
  requested_by: string;
  request_type: ServiceRequestType;
  note?: string | null;
}

export interface CreateFrozenBillInput {
  session_id: string;
  restaurant_id: string;
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  total_amount: number;
}

// ------------------------------------------------------------
// Plain (non-transactional) repository contracts.
// ------------------------------------------------------------

export interface DineZoneRepository {
  getById(zoneId: string): Promise<DineZoneDTO | null>;
  getByRestaurant(restaurantId: string): Promise<DineZoneDTO[]>;
  getActive(restaurantId: string): Promise<DineZoneDTO[]>;
  create(input: CreateDineZoneInput): Promise<DineZoneDTO>;
  setActive(zoneId: string, isActive: boolean): Promise<DineZoneDTO | null>;
  rename(zoneId: string, name: string): Promise<DineZoneDTO | null>;
}

export interface RestaurantTableRepository {
  getById(tableId: string): Promise<RestaurantTableDTO | null>;
  getByRestaurant(restaurantId: string): Promise<RestaurantTableDTO[]>;
  getByZone(zoneId: string): Promise<RestaurantTableDTO[]>;
  findByToken(tableToken: string): Promise<RestaurantTableDTO | null>;
  create(input: CreateRestaurantTableInput): Promise<RestaurantTableDTO>;
  setZone(tableId: string, zoneId: string | null): Promise<RestaurantTableDTO | null>;
  setActive(tableId: string, isActive: boolean): Promise<RestaurantTableDTO | null>;
}

// Read-only public resolve (frozen UI1-A-R1/R2): informational only, never
// authoritative. Unknown / disabled table / inactive restaurant all collapse
// to a single null (not-found) representation. No lock, no transaction, no
// mutation, no reservation promise.
export interface TableResolveRepository {
  resolveByToken(tableToken: string): Promise<TableResolveDTO | null>;
}

export interface DiningSessionRepository {
  getById(sessionId: string): Promise<DiningSessionDTO | null>;
  findLiveByTable(tableId: string): Promise<DiningSessionDTO | null>;
  getByTable(tableId: string): Promise<DiningSessionDTO[]>;
  create(input: CreateDiningSessionInput): Promise<DiningSessionDTO>;
  transitionStatus(
    sessionId: string,
    from: DiningSessionStatus,
    to: DiningSessionStatus,
    timestamps?: Partial<
      Pick<DiningSessionDTO, "bill_requested_at" | "payment_pending_at" | "closed_at">
    >,
  ): Promise<TransitionResult<DiningSessionDTO, DiningSessionStatus>>;
}

export interface StaffAssignmentRepository {
  getBySession(sessionId: string): Promise<StaffAssignmentDTO[]>;
  getActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null>;
  getActiveByRestaurant(restaurantId: string): Promise<StaffAssignmentDTO[]>;
  create(input: CreateStaffAssignmentInput): Promise<StaffAssignmentDTO>;
  endAssignment(
    assignmentId: string,
    endedAt: string,
  ): Promise<TransitionResult<StaffAssignmentDTO, StaffAssignmentStatus>>;
}

export interface DineInOrderRepository {
  getById(orderId: string): Promise<DineInOrderDTO | null>;
  getBySession(sessionId: string): Promise<DineInOrderDTO[]>;
  getBySessionWithItems(sessionId: string): Promise<DineInOrderWithItemsDTO[]>;
  create(input: CreateDineInOrderInput): Promise<DineInOrderDTO>;
  transitionStatus(
    orderId: string,
    from: DineInOrderStatus,
    to: DineInOrderStatus,
    metadata?: {
      cancelled_by?: string;
      cancelled_at?: string;
      served_at?: string;
    },
  ): Promise<TransitionResult<DineInOrderDTO, DineInOrderStatus>>;
  listForBill(sessionId: string): Promise<DineInOrderWithItemsDTO[]>;
  /** Kitchen execution queue (DINE-OPS1.2): actionable statuses only, oldest
   *  first, table/session derived by the repository. */
  getKitchenQueueByRestaurant(restaurantId: string): Promise<DineInKitchenOrderDTO[]>;
}

export interface ServiceRequestRepository {
  getById(requestId: string): Promise<ServiceRequestDTO | null>;
  getBySession(sessionId: string): Promise<ServiceRequestDTO[]>;
  /** PENDING + ACKNOWLEDGED, oldest first (FIFO). Ordering is impl detail. */
  getPendingByRestaurant(restaurantId: string): Promise<ServiceRequestDTO[]>;
  /**
   * Vendor operations queue (DINE-OPS2): PENDING + ACKNOWLEDGED oldest-first,
   * EXCLUDING BRING_BILL, each with the server-derived table identity. The
   * repository owns the session -> table derivation (no route-side N+1).
   */
  getOperationsQueueByRestaurant(
    restaurantId: string,
  ): Promise<ServiceRequestOperationsDTO[]>;
  create(input: CreateServiceRequestInput): Promise<ServiceRequestDTO>;
  acknowledge(
    requestId: string,
    acknowledgedBy: string,
    acknowledgedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>>;
  complete(
    requestId: string,
    completedBy: string,
    completedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>>;
  cancel(
    requestId: string,
    cancelledBy: string,
    cancelledAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>>;
  findBringBillBySession(sessionId: string): Promise<ArtifactLookup<ServiceRequestDTO>>;
}

/**
 * Vendor Dine-In table/session board (DINE-OPS3): a dedicated read model
 * repository so the route performs no joins and no N+1. Every restaurant
 * table (including disabled ones) is returned with the server-derived live
 * session and actionable counts, resolved from a bounded fixed query set.
 * Read-only — no mutation surface.
 */
export interface DineInTableBoardReadRepository {
  getByRestaurant(restaurantId: string): Promise<VendorTableBoardRow[]>;
}

export interface SessionBillRepository {
  getBySessionId(sessionId: string): Promise<SessionBillDTO | null>;
  createFrozenBill(input: CreateFrozenBillInput): Promise<SessionBillDTO>;
}

// ------------------------------------------------------------
// Vendor Dine-In bill read model (DINE-OPS4-B1, read-only).
//
// Public wire DTOs (frozen DINE-OPS4-A1R1/A1R2). These shapes are the exact
// JSON contract for the vendor bill endpoints:
//   GET  /api/vendor/dine-in/bills?restaurant_id=<uuid>
//          -> VendorPendingBillRow[]
//   GET  /api/vendor/dine-in/bills/:billId
//          -> VendorBillDetail
//   POST /api/vendor/dine-in/bills/:billId/acknowledge
//          -> { request: ServiceRequestDTO }
//   POST /api/vendor/dine-in/bills/:billId/deliver
//          -> { request: ServiceRequestDTO }
//
// Membership rules:
//   - The actionable queue is exactly the sessions where
//     session.status === "BILL_REQUESTED" AND the session's BRING_BILL
//     artifact status is PENDING or ACKNOWLEDGED. A delivered (COMPLETED)
//     artifact leaves the queue; the bill detail stays readable.
//   - Queue ordering is bill_requested_at ASC, then bill.id ASC
//     (deterministic).
//   - Bill actions are legal ONLY while session.status === "BILL_REQUESTED".
//   - A BILL_REQUESTED session must carry EXACTLY ONE BRING_BILL artifact;
//     NONE or MULTIPLE is a BILL_INVARIANT_VIOLATION (500). That invariant is
//     enforced ONLY inside the post-authorization repository reads below —
//     never by getAccessContextByBillId, which is invariant-free so the
//     404/403 precedence can never leak a corrupted state before
//     authorization.
//
// The following never appear on the wire: owner_user_id, requested_by,
// table_token, payment_method / payment_status / payment_transaction_id,
// settlement and close-session fields.
// ------------------------------------------------------------

// The frozen bill half of both bill read models (SessionBillDTO minus the
// non-wire created_at).
export interface VendorBillTotalsDTO {
  id: string;
  session_id: string;
  restaurant_id: string;
  food_subtotal: number;
  packaging_fee: number;
  gst_food: number;
  gst_packaging: number;
  total_amount: number;
  frozen_at: string;
}

// BRING_BILL statuses that keep a bill on the actionable queue.
export const BRING_BILL_QUEUE_STATUSES: ServiceRequestStatus[] = [
  "PENDING",
  "ACKNOWLEDGED",
];

// BRING_BILL statuses surfaced on the bill detail (COMPLETED keeps the
// delivered bill readable; CANCELLED is unreachable — the billing flow owns
// BRING_BILL cancellation and never cancels it).
export const BRING_BILL_VISIBLE_STATUSES: ServiceRequestStatus[] = [
  "PENDING",
  "ACKNOWLEDGED",
  "COMPLETED",
];

export interface VendorPendingBillRow {
  bill: VendorBillTotalsDTO;
  session: {
    id: string;
    status: "BILL_REQUESTED";
    bill_requested_at: string;
    opened_at: string;
  };
  table: {
    id: string;
    label: string;
  };
  bring_bill_request: {
    id: string;
    status: "PENDING" | "ACKNOWLEDGED";
  };
}

export interface VendorBillDetail {
  bill: VendorBillTotalsDTO;
  session: {
    id: string;
    status: DiningSessionStatus;
    bill_requested_at: string | null;
    opened_at: string;
  };
  table: {
    id: string;
    label: string;
  };
  zone: {
    id: string;
    name: string;
  } | null;
  bring_bill_request: {
    id: string;
    status: "PENDING" | "ACKNOWLEDGED" | "COMPLETED";
    acknowledged_at: string | null;
    completed_at: string | null;
  } | null;
  orders: Array<{
    id: string;
    status: DineInOrderStatus;
    created_at: string;
    items: Array<{
      name: string;
      quantity: number;
      item_subtotal: number;
    }>;
  }>;
}

// Pre-authorization discovery (existence + owning restaurant only). No joins,
// no invariant checks, no session/service-request reads.
export interface BillAccessContext {
  bill_id: string;
  session_id: string;
  restaurant_id: string;
}

// Post-authorization action context. session.status truthfully reflects the
// current session (the caller enforces the BILL_REQUESTED action boundary);
// bring_bill_request is null only outside BILL_REQUESTED.
export interface BillActionContext {
  session: {
    id: string;
    status: DiningSessionStatus;
  };
  bring_bill_request: {
    id: string;
    status: ServiceRequestStatus;
  } | null;
}

/**
 * Vendor Dine-In bill read surface (DINE-OPS4-B1): a dedicated read model
 * repository so the routes perform no joins and no N+1 (bounded fixed query
 * set in postgres mode). Read-only — no mutation surface; bill actions go
 * through the frozen DiningSessionService.
 *
 * Authorization split (caller contract):
 *   1. getAccessContextByBillId is INVARIANT-FREE discovery used BEFORE the
 *      restaurant gate (missing bill -> null -> route 404; then gate 403).
 *   2. getBillDetailByBillId / getBillActionContextByBillId are
 *      POST-authorization reads. While session.status === "BILL_REQUESTED"
 *      they throw BILL_INVARIANT_VIOLATION (500) when the session has zero or
 *      more than one BRING_BILL artifact — never reachable before a 403.
 */
export interface DineInBillReadRepository {
  getAccessContextByBillId(billId: string): Promise<BillAccessContext | null>;
  getPendingQueueByRestaurant(
    restaurantId: string,
  ): Promise<VendorPendingBillRow[]>;
  getBillDetailByBillId(billId: string): Promise<VendorBillDetail | null>;
  getBillActionContextByBillId(
    billId: string,
  ): Promise<BillActionContext | null>;
  /**
   * Admin Dine-In live-session frozen-bill read (ADMIN-OPS1-A2): returns the
   * frozen bill snapshot for a session_id, or null when the session has no
   * frozen bill. Read-only and invariant-free (never throws) — this feeds
   * admin live-operations oversight over DELIVERED-or-later bills, not the
   * actionable vendor queue, so no BILL_INVARIANT_VIOLATION and no
   * payment/settlement state invention.
   */
  getFrozenBillBySessionId(
    sessionId: string,
  ): Promise<VendorBillTotalsDTO | null>;
}

// ------------------------------------------------------------
// Transactional variants: row-lock primitives (frozen D2.4H2).
// Exact lock set only — no extra lock methods.
// ------------------------------------------------------------

export interface TransactionalRestaurantTableRepository extends RestaurantTableRepository {
  lockById(tableId: string): Promise<RestaurantTableDTO | null>;
  lockByToken(tableToken: string): Promise<RestaurantTableDTO | null>;
}

export interface TransactionalDiningSessionRepository extends DiningSessionRepository {
  lockById(sessionId: string): Promise<DiningSessionDTO | null>;
  lockLiveByTable(tableId: string): Promise<DiningSessionDTO | null>;
}

export interface TransactionalStaffAssignmentRepository extends StaffAssignmentRepository {
  lockActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null>;
}

export interface TransactionalDineInOrderRepository extends DineInOrderRepository {
  lockById(orderId: string): Promise<DineInOrderDTO | null>;
}

export interface TransactionalServiceRequestRepository extends ServiceRequestRepository {
  lockById(requestId: string): Promise<ServiceRequestDTO | null>;
}

// Narrow eligibility reader (frozen D2.4C): id + is_active only.
export interface TransactionalRestaurantReader {
  getEligibility(restaurantId: string): Promise<RestaurantEligibilityDTO | null>;
}

// ------------------------------------------------------------
// Transaction port (frozen D2.4B / D2.4G).
// ------------------------------------------------------------

// Branded so a SessionBillRepository can only be produced through the
// tx-bound construction path — a shared/global bill repo is unrepresentable.
declare const txBoundSessionBill: unique symbol;
export type TxBoundSessionBillRepository = SessionBillRepository & {
  readonly [txBoundSessionBill]: true;
};

export function makeTxBoundSessionBill(
  repo: SessionBillRepository,
): TxBoundSessionBillRepository {
  return repo as TxBoundSessionBillRepository;
}

export interface DineInTransactionRepos {
  restaurantTables: TransactionalRestaurantTableRepository;
  diningSessions: TransactionalDiningSessionRepository;
  staffAssignments: TransactionalStaffAssignmentRepository;
  dineInOrders: TransactionalDineInOrderRepository;
  serviceRequests: TransactionalServiceRequestRepository;
  sessionBills: TxBoundSessionBillRepository;
  restaurantEligibility: TransactionalRestaurantReader;
}

export type DineInTransactionReposFactory = (tx: DrizzleDb) => DineInTransactionRepos;

export interface DineInTransactionPort {
  runInTransaction<T>(
    fn: (repos: DineInTransactionRepos) => Promise<T>,
  ): Promise<T>;
}
