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

export interface SessionBillRepository {
  getBySessionId(sessionId: string): Promise<SessionBillDTO | null>;
  createFrozenBill(input: CreateFrozenBillInput): Promise<SessionBillDTO>;
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
