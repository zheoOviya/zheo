import { randomUUID } from "node:crypto";
import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
  StaffAssignmentStatus,
} from "@snakzap/types";
import { AppError } from "../middleware/envelope";
import {
  BRING_BILL_QUEUE_STATUSES,
  BRING_BILL_VISIBLE_STATUSES,
  makeTxBoundSessionBill,
  KITCHEN_ORDER_STATUSES,
} from "./dineInContracts";
import type {
  ArtifactLookup,
  BillAccessContext,
  BillActionContext,
  CreateDineInOrderInput,
  CreateDiningSessionInput,
  CreateFrozenBillInput,
  CreateRestaurantTableInput,
  CreateServiceRequestInput,
  CreateStaffAssignmentInput,
  DineInBillReadRepository,
  DineInOrderDTO,
  DineInKitchenOrderDTO,
  DineInOrderItemDTO,
  DineInOrderWithItemsDTO,
  DineInTableBoardReadRepository,
  DineInTransactionPort,
  DineInTransactionRepos,
  DiningSessionDTO,
  DineZoneDTO,
  RestaurantEligibilityDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  ServiceRequestOperationsDTO,
  SessionBillDTO,
  SessionBillRepository,
  StaffAssignmentDTO,
  TableResolveDTO,
  TableResolveRepository,
  VendorBillDetail,
  VendorBillTotalsDTO,
  VendorPendingBillRow,
  VendorTableBoardRow,
  TransitionResult,
  TransactionalRestaurantReader,
  TransactionalDineInOrderRepository,
  TransactionalDiningSessionRepository,
  TransactionalRestaurantTableRepository,
  TransactionalServiceRequestRepository,
  TransactionalStaffAssignmentRepository,
} from "./dineInContracts";

// ============================================================
// Dine-In in-memory repositories (H2.1).
//
// These implement the frozen Dine-In repository contracts for
// memory/test storage ONLY. They are contract-complete so the accepted
// DiningSessionService / DineInOrderService can be constructed in memory
// mode without a database.
//
// Explicitly NOT provided:
//   - no real rollback on failure (MemoryDineInTransactionPort simply runs
//     the callback against the shared in-memory set)
//   - no FOR UPDATE / row-lock semantics (lock* methods are plain reads)
//   - no MVCC / snapshot isolation / concurrency serialization
//   - no unique-index race behavior
//
// The Drizzle transaction port and real PostgreSQL semantics remain the
// production path (D2.5I owns any real-PG proof). Domain/state-machine rules
// live in the services, never here.
//
// _reset()/_seed() are the project's established memory-repository test
// surface (same convention as MemoryOrderRepository / MemoryPaymentRepository
// in this directory tree).
// ============================================================

const nowIso = (): string => new Date().toISOString();

const LIVE_SESSION_STATUSES: DiningSessionStatus[] = [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
];
const PENDING_REQUEST_STATUSES: ServiceRequestStatus[] = ["PENDING", "ACKNOWLEDGED"];
const CANCELLABLE_REQUEST_STATUSES: ServiceRequestStatus[] = ["PENDING", "ACKNOWLEDGED"];

// ------------------------------------------------------------
// Restaurant tables.
// ------------------------------------------------------------

export class MemoryRestaurantTableRepository
  implements TransactionalRestaurantTableRepository, TableResolveRepository
{
  private tables = new Map<string, RestaurantTableDTO>();

  // Minimal trusted display store for the public resolve read model
  // (frozen UI1-A-R2): only restaurant identity + name + active flag.
  private restaurantDisplays = new Map<
    string,
    { id: string; name: string; is_active: boolean }
  >();

  async getById(tableId: string): Promise<RestaurantTableDTO | null> {
    return this.tables.get(tableId) ?? null;
  }

  async getByRestaurant(restaurantId: string): Promise<RestaurantTableDTO[]> {
    return Array.from(this.tables.values()).filter(
      (t) => t.restaurant_id === restaurantId,
    );
  }

  async getByZone(zoneId: string): Promise<RestaurantTableDTO[]> {
    return Array.from(this.tables.values()).filter((t) => t.zone_id === zoneId);
  }

  async findByToken(tableToken: string): Promise<RestaurantTableDTO | null> {
    for (const t of this.tables.values()) {
      if (t.table_token === tableToken) return t;
    }
    return null;
  }

  async create(input: CreateRestaurantTableInput): Promise<RestaurantTableDTO> {
    const now = nowIso();
    const table: RestaurantTableDTO = {
      id: randomUUID(),
      restaurant_id: input.restaurant_id,
      zone_id: input.zone_id ?? null,
      label: input.label,
      table_token: input.table_token,
      seat_count: input.seat_count ?? null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    this.tables.set(table.id, table);
    return table;
  }

  async setZone(
    tableId: string,
    zoneId: string | null,
  ): Promise<RestaurantTableDTO | null> {
    const current = this.tables.get(tableId);
    if (!current) return null;
    const updated: RestaurantTableDTO = {
      ...current,
      zone_id: zoneId,
      updated_at: nowIso(),
    };
    this.tables.set(tableId, updated);
    return updated;
  }

  async setActive(
    tableId: string,
    isActive: boolean,
  ): Promise<RestaurantTableDTO | null> {
    const current = this.tables.get(tableId);
    if (!current) return null;
    const updated: RestaurantTableDTO = {
      ...current,
      is_active: isActive,
      updated_at: nowIso(),
    };
    this.tables.set(tableId, updated);
    return updated;
  }

  async lockById(tableId: string): Promise<RestaurantTableDTO | null> {
    return this.getById(tableId);
  }

  async lockByToken(tableToken: string): Promise<RestaurantTableDTO | null> {
    return this.findByToken(tableToken);
  }

  // Read-only public table resolution (frozen UI1-A-R2). Mirrors
  // DrizzleRestaurantTableRepository.resolveByToken: active table by token,
  // then active restaurant display by restaurant_id; either missing or
  // inactive collapses to null (the service maps null to TABLE_NOT_FOUND
  // 404). Informational only - no lock, no mutation, no occupancy promise.
  async resolveByToken(tableToken: string): Promise<TableResolveDTO | null> {
    let table: RestaurantTableDTO | null = null;
    for (const t of this.tables.values()) {
      if (t.table_token === tableToken && t.is_active) {
        table = t;
        break;
      }
    }
    if (!table) return null;
    const restaurant = this.restaurantDisplays.get(table.restaurant_id);
    if (!restaurant || !restaurant.is_active) return null;
    return {
      restaurant: { id: restaurant.id, name: restaurant.name },
      table: { id: table.id, label: table.label },
      can_start_session: true,
    };
  }

  _reset(): void {
    this.tables.clear();
    this.restaurantDisplays.clear();
  }

  _seed(table: RestaurantTableDTO): RestaurantTableDTO {
    this.tables.set(table.id, table);
    return table;
  }

  _seedRestaurant(display: {
    id: string;
    name: string;
    is_active: boolean;
  }): void {
    this.restaurantDisplays.set(display.id, display);
  }
}

// ------------------------------------------------------------
// Dining sessions.
// ------------------------------------------------------------

export class MemoryDiningSessionRepository
  implements TransactionalDiningSessionRepository
{
  private sessions = new Map<string, DiningSessionDTO>();

  async getById(sessionId: string): Promise<DiningSessionDTO | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async findLiveByTable(tableId: string): Promise<DiningSessionDTO | null> {
    for (const s of this.sessions.values()) {
      if (s.table_id === tableId && LIVE_SESSION_STATUSES.includes(s.status)) {
        return s;
      }
    }
    return null;
  }

  async getByTable(tableId: string): Promise<DiningSessionDTO[]> {
    return Array.from(this.sessions.values()).filter((s) => s.table_id === tableId);
  }

  async create(input: CreateDiningSessionInput): Promise<DiningSessionDTO> {
    const now = nowIso();
    const session: DiningSessionDTO = {
      id: randomUUID(),
      restaurant_id: input.restaurant_id,
      table_id: input.table_id,
      owner_user_id: input.owner_user_id,
      status: "OPEN",
      bill_requested_at: null,
      payment_pending_at: null,
      closed_at: null,
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async transitionStatus(
    sessionId: string,
    from: DiningSessionStatus,
    to: DiningSessionStatus,
    timestamps?: Partial<
      Pick<DiningSessionDTO, "bill_requested_at" | "payment_pending_at" | "closed_at">
    >,
  ): Promise<TransitionResult<DiningSessionDTO, DiningSessionStatus>> {
    const current = this.sessions.get(sessionId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== from) {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: DiningSessionDTO = {
      ...current,
      status: to,
      bill_requested_at: timestamps?.bill_requested_at ?? current.bill_requested_at,
      payment_pending_at:
        timestamps?.payment_pending_at ?? current.payment_pending_at,
      closed_at: timestamps?.closed_at ?? current.closed_at,
      updated_at: nowIso(),
    };
    this.sessions.set(sessionId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async lockById(sessionId: string): Promise<DiningSessionDTO | null> {
    return this.getById(sessionId);
  }

  async lockLiveByTable(tableId: string): Promise<DiningSessionDTO | null> {
    return this.findLiveByTable(tableId);
  }

  _reset(): void {
    this.sessions.clear();
  }

  _seed(session: DiningSessionDTO): DiningSessionDTO {
    this.sessions.set(session.id, session);
    return session;
  }
}

// ------------------------------------------------------------
// Staff assignments.
// ------------------------------------------------------------

export class MemoryStaffAssignmentRepository
  implements TransactionalStaffAssignmentRepository
{
  private assignments = new Map<string, StaffAssignmentDTO>();

  private readById(assignmentId: string): StaffAssignmentDTO | null {
    return this.assignments.get(assignmentId) ?? null;
  }

  async getBySession(sessionId: string): Promise<StaffAssignmentDTO[]> {
    return Array.from(this.assignments.values()).filter(
      (a) => a.session_id === sessionId,
    );
  }

  async getActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null> {
    for (const a of this.assignments.values()) {
      if (a.session_id === sessionId && a.status === "ACTIVE") return a;
    }
    return null;
  }

  async getActiveByRestaurant(restaurantId: string): Promise<StaffAssignmentDTO[]> {
    return Array.from(this.assignments.values()).filter(
      (a) => a.restaurant_id === restaurantId && a.status === "ACTIVE",
    );
  }

  async create(input: CreateStaffAssignmentInput): Promise<StaffAssignmentDTO> {
    const now = nowIso();
    const assignment: StaffAssignmentDTO = {
      id: randomUUID(),
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      staff_user_id: input.staff_user_id,
      assigned_by: input.assigned_by ?? null,
      zone_id: input.zone_id ?? null,
      status: "ACTIVE",
      assigned_at: now,
      ended_at: null,
    };
    this.assignments.set(assignment.id, assignment);
    return assignment;
  }

  async endAssignment(
    assignmentId: string,
    endedAt: string,
  ): Promise<TransitionResult<StaffAssignmentDTO, StaffAssignmentStatus>> {
    const current = this.readById(assignmentId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "ACTIVE") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: StaffAssignmentDTO = {
      ...current,
      status: "ENDED",
      ended_at: endedAt,
    };
    this.assignments.set(assignmentId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async lockActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null> {
    return this.getActiveBySession(sessionId);
  }

  _reset(): void {
    this.assignments.clear();
  }

  _seed(assignment: StaffAssignmentDTO): StaffAssignmentDTO {
    this.assignments.set(assignment.id, assignment);
    return assignment;
  }
}

// ------------------------------------------------------------
// Dine-in orders + items.
// ------------------------------------------------------------

export class MemoryDineInOrderRepository
  implements TransactionalDineInOrderRepository
{
  private orders = new Map<string, DineInOrderWithItemsDTO>();

  // DINE-OPS1.2 kitchen queue: the order repo derives table/session from the
  // same shared memory universe, so the vendor read model needs no client
  // input. Both are optional for unit isolation; buildMemoryDineInRepos wires
  // them to the shared instances.
  constructor(
    private readonly sessions?: MemoryDiningSessionRepository,
    private readonly tables?: MemoryRestaurantTableRepository,
  ) {}

  async getById(orderId: string): Promise<DineInOrderDTO | null> {
    return this.orders.get(orderId) ?? null;
  }

  async getBySession(sessionId: string): Promise<DineInOrderDTO[]> {
    return Array.from(this.orders.values()).filter((o) => o.session_id === sessionId);
  }

  async getBySessionWithItems(
    sessionId: string,
  ): Promise<DineInOrderWithItemsDTO[]> {
    return Array.from(this.orders.values()).filter((o) => o.session_id === sessionId);
  }

  async create(input: CreateDineInOrderInput): Promise<DineInOrderDTO> {
    const now = nowIso();
    const items: DineInOrderItemDTO[] = input.items.map((item) => ({
      id: randomUUID(),
      dine_in_order_id: "",
      restaurant_id: input.restaurant_id,
      menu_item_id: item.menu_item_id,
      name: item.name,
      base_price: item.base_price,
      quantity: item.quantity,
      customizations: item.customizations,
      customization_total: item.customization_total,
      item_subtotal: item.item_subtotal,
      created_at: now,
    }));
    const order: DineInOrderWithItemsDTO = {
      id: randomUUID(),
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      placed_by: input.placed_by,
      status: "PLACED",
      total_amount: input.total_amount,
      notes: input.notes ?? null,
      served_at: null,
      cancelled_at: null,
      cancelled_by: null,
      created_at: now,
      updated_at: now,
      items,
    };
    for (const item of items) {
      item.dine_in_order_id = order.id;
    }
    this.orders.set(order.id, order);
    return order;
  }

  async transitionStatus(
    orderId: string,
    from: DineInOrderDTO["status"],
    to: DineInOrderDTO["status"],
    metadata?: { cancelled_by?: string; cancelled_at?: string; served_at?: string },
  ): Promise<TransitionResult<DineInOrderDTO, DineInOrderDTO["status"]>> {
    const current = this.orders.get(orderId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== from) {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: DineInOrderWithItemsDTO = {
      ...current,
      status: to,
      cancelled_by: metadata?.cancelled_by ?? current.cancelled_by,
      cancelled_at: metadata?.cancelled_at ?? current.cancelled_at,
      served_at:
        to === "SERVED" && metadata?.served_at
          ? metadata.served_at
          : current.served_at,
      updated_at: nowIso(),
    };
    this.orders.set(orderId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async listForBill(sessionId: string): Promise<DineInOrderWithItemsDTO[]> {
    return Array.from(this.orders.values()).filter(
      (o) => o.session_id === sessionId && o.status !== "CANCELLED",
    );
  }

  async getKitchenQueueByRestaurant(
    restaurantId: string,
  ): Promise<DineInKitchenOrderDTO[]> {
    const orders = Array.from(this.orders.values())
      .filter(
        (o) =>
          o.restaurant_id === restaurantId &&
          KITCHEN_ORDER_STATUSES.includes(o.status),
      )
      .sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    const result: DineInKitchenOrderDTO[] = [];
    for (const order of orders) {
      const session = this.sessions
        ? await this.sessions.getById(order.session_id)
        : null;
      const table = session && this.tables
        ? await this.tables.getById(session.table_id)
        : null;
      result.push({
        id: order.id,
        session_id: order.session_id,
        status: order.status,
        total_amount: order.total_amount,
        created_at: order.created_at,
        table: { id: table?.id ?? "", label: table?.label ?? "" },
        items: order.items.map((i) => ({
          menu_item_id: i.menu_item_id,
          name: i.name,
          quantity: i.quantity,
          item_subtotal: i.item_subtotal,
        })),
      });
    }
    return result;
  }

  async lockById(orderId: string): Promise<DineInOrderDTO | null> {
    return this.getById(orderId);
  }

  _reset(): void {
    this.orders.clear();
  }

  _seed(order: DineInOrderWithItemsDTO): DineInOrderWithItemsDTO {
    this.orders.set(order.id, order);
    return order;
  }
}

// ------------------------------------------------------------
// Service requests.
// ------------------------------------------------------------

export class MemoryServiceRequestRepository
  implements TransactionalServiceRequestRepository
{
  private requests = new Map<string, ServiceRequestDTO>();

  // DINE-OPS2 operations queue: the request repo derives the vendor read-model
  // table from the same shared memory universe (service_requests.session_id ->
  // dining_sessions.table_id -> restaurant_tables). Both are optional for unit
  // isolation; buildMemoryDineInRepos wires them to the shared instances.
  constructor(
    private readonly sessions?: MemoryDiningSessionRepository,
    private readonly tables?: MemoryRestaurantTableRepository,
  ) {}

  async getById(requestId: string): Promise<ServiceRequestDTO | null> {
    return this.requests.get(requestId) ?? null;
  }

  async getBySession(sessionId: string): Promise<ServiceRequestDTO[]> {
    return Array.from(this.requests.values()).filter(
      (r) => r.session_id === sessionId,
    );
  }

  async getPendingByRestaurant(restaurantId: string): Promise<ServiceRequestDTO[]> {
    return Array.from(this.requests.values())
      .filter(
        (r) =>
          r.restaurant_id === restaurantId &&
          PENDING_REQUEST_STATUSES.includes(r.status),
      )
      .sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
  }

  // DINE-OPS2 vendor operations queue: PENDING + ACKNOWLEDGED, BRING_BILL
  // excluded, table identity derived server-side from the shared session/table
  // universe (no client input). Ordering mirrors the Drizzle implementation
  // exactly: (created_at ASC, id ASC) — deterministic across equal timestamps.
  // A request whose session/table cannot be resolved is OMITTED (inner-join
  // semantics); an empty fake table identity is never emitted.
  async getOperationsQueueByRestaurant(
    restaurantId: string,
  ): Promise<ServiceRequestOperationsDTO[]> {
    const requests = Array.from(this.requests.values())
      .filter(
        (r) =>
          r.restaurant_id === restaurantId &&
          PENDING_REQUEST_STATUSES.includes(r.status) &&
          r.request_type !== "BRING_BILL",
      )
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
          a.id.localeCompare(b.id),
      );
    const results: ServiceRequestOperationsDTO[] = [];
    for (const request of requests) {
      const session = this.sessions
        ? await this.sessions.getById(request.session_id)
        : null;
      const table = session && this.tables
        ? await this.tables.getById(session.table_id)
        : null;
      if (!session || !table) {
        // Mirrors the Drizzle inner-join semantics (see drizzle queue impl):
        // no resolvable server-derived table identity -> row is not part of
        // the actionable queue.
        continue;
      }
      results.push({
        id: request.id,
        session_id: request.session_id,
        restaurant_id: request.restaurant_id,
        request_type: request.request_type,
        status: request.status,
        note: request.note,
        created_at: request.created_at,
        table: { id: table.id, label: table.label },
      });
    }
    return results;
  }

  async create(input: CreateServiceRequestInput): Promise<ServiceRequestDTO> {
    const now = nowIso();
    const request: ServiceRequestDTO = {
      id: randomUUID(),
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      requested_by: input.requested_by,
      request_type: input.request_type,
      status: "PENDING",
      note: input.note ?? null,
      acknowledged_by: null,
      acknowledged_at: null,
      completed_by: null,
      completed_at: null,
      cancelled_by: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    };
    this.requests.set(request.id, request);
    return request;
  }

  async acknowledge(
    requestId: string,
    acknowledgedBy: string,
    acknowledgedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = this.requests.get(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "PENDING") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: ServiceRequestDTO = {
      ...current,
      status: "ACKNOWLEDGED",
      acknowledged_by: acknowledgedBy,
      acknowledged_at: acknowledgedAt,
      updated_at: nowIso(),
    };
    this.requests.set(requestId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async complete(
    requestId: string,
    completedBy: string,
    completedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = this.requests.get(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "ACKNOWLEDGED") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: ServiceRequestDTO = {
      ...current,
      status: "COMPLETED",
      completed_by: completedBy,
      completed_at: completedAt,
      updated_at: nowIso(),
    };
    this.requests.set(requestId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async cancel(
    requestId: string,
    cancelledBy: string,
    cancelledAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = this.requests.get(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (!CANCELLABLE_REQUEST_STATUSES.includes(current.status)) {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    const updated: ServiceRequestDTO = {
      ...current,
      status: "CANCELLED",
      cancelled_by: cancelledBy,
      cancelled_at: cancelledAt,
      updated_at: nowIso(),
    };
    this.requests.set(requestId, updated);
    return { kind: "UPDATED", value: updated };
  }

  async findBringBillBySession(
    sessionId: string,
  ): Promise<ArtifactLookup<ServiceRequestDTO>> {
    const matches = Array.from(this.requests.values()).filter(
      (r) => r.session_id === sessionId && r.request_type === "BRING_BILL",
    );
    if (matches.length === 0) return { kind: "NONE" };
    if (matches.length === 1) return { kind: "FOUND", value: matches[0]! };
    return { kind: "MULTIPLE", values: matches };
  }

  async lockById(requestId: string): Promise<ServiceRequestDTO | null> {
    return this.getById(requestId);
  }

  _reset(): void {
    this.requests.clear();
  }

  _seed(request: ServiceRequestDTO): ServiceRequestDTO {
    this.requests.set(request.id, request);
    return request;
  }
}

// ------------------------------------------------------------
// Dine-in table/session board (DINE-OPS3, read-only).
// ------------------------------------------------------------

// DINE-OPS3 vendor occupancy board: mirrors the Drizzle read-model semantics
// over the shared in-memory universe. All dependencies are optional for unit
// isolation; buildMemoryDineInRepos / dineInComposition wire the shared
// instances. Zone names are held by THIS repository (a small memory-only
// registry seeded via _seedZone) because the shared transaction repo set has
// no zone store; the Drizzle implementation reads the real dine_zones rows.
// A table whose zone_id does not resolve to a seeded zone is surfaced with
// zone: null (truthful). A disabled table that still carries a live session
// reports BOTH facts. Ordering is deterministic: (label ASC, id ASC).
export class MemoryDineInTableBoardRepository
  implements DineInTableBoardReadRepository
{
  private zones = new Map<string, DineZoneDTO>();

  constructor(
    private readonly tables?: MemoryRestaurantTableRepository,
    private readonly sessions?: MemoryDiningSessionRepository,
    private readonly orders?: MemoryDineInOrderRepository,
    private readonly requests?: MemoryServiceRequestRepository,
  ) {}

  async getByRestaurant(restaurantId: string): Promise<VendorTableBoardRow[]> {
    const restaurantZones = new Map<string, { id: string; name: string }>();
    for (const z of this.zones.values()) {
      if (z.restaurant_id === restaurantId) {
        restaurantZones.set(z.id, { id: z.id, name: z.name });
      }
    }

    const tables = this.tables
      ? await this.tables.getByRestaurant(restaurantId)
      : [];
    const rows: VendorTableBoardRow[] = [];
    for (const t of tables) {
      const session = this.sessions
        ? await this.sessions.findLiveByTable(t.id)
        : null;
      // Restaurant-scope guard mirrors the Drizzle query: a session that does
      // not belong to the requested restaurant is never surfaced on its table.
      const scoped = session && session.restaurant_id === restaurantId ? session : null;

      let openOrderCount = 0;
      let openRequestCount = 0;
      if (scoped && this.orders) {
        const orders = await this.orders.getBySession(scoped.id);
        // Defensive restaurant filter mirrors the Drizzle query (which scopes
        // by BOTH restaurant_id and session_id). The composite FK forbids a
        // cross-restaurant child in any reachable state, so behavior is
        // unchanged — this keeps the two read models identical by construction.
        openOrderCount = orders.filter(
          (o) =>
            o.restaurant_id === restaurantId &&
            KITCHEN_ORDER_STATUSES.includes(o.status),
        ).length;
      }
      if (scoped && this.requests) {
        const requests = await this.requests.getBySession(scoped.id);
        openRequestCount = requests.filter(
          (r) =>
            r.restaurant_id === restaurantId &&
            PENDING_REQUEST_STATUSES.includes(r.status) &&
            r.request_type !== "BRING_BILL",
        ).length;
      }

      rows.push({
        table: {
          id: t.id,
          label: t.label,
          seat_count: t.seat_count,
          is_active: t.is_active,
        },
        zone: t.zone_id ? (restaurantZones.get(t.zone_id) ?? null) : null,
        session: scoped
          ? {
              id: scoped.id,
              status: scoped.status,
              opened_at: scoped.created_at,
              bill_requested_at: scoped.bill_requested_at,
            }
          : null,
        open_order_count: scoped ? openOrderCount : 0,
        open_request_count: scoped ? openRequestCount : 0,
      });
    }

    rows.sort(
      (a, b) =>
        a.table.label.localeCompare(b.table.label) ||
        a.table.id.localeCompare(b.table.id),
    );
    return rows;
  }

  /** Memory-only zone registry (test seeding seam). */
  _seedZone(zone: DineZoneDTO): DineZoneDTO {
    this.zones.set(zone.id, zone);
    return zone;
  }

  /** Narrow zone lookup shared with the vendor bill read model (memory mode
   *  only) so both read models resolve zone names from the SAME registry the
   *  route tests seed via _seedZone. */
  getZoneById(zoneId: string): { id: string; name: string } | null {
    const zone = this.zones.get(zoneId);
    return zone ? { id: zone.id, name: zone.name } : null;
  }

  _reset(): void {
    this.zones.clear();
  }
}

// ------------------------------------------------------------
// Session bills (insert-only, immutable).
// ------------------------------------------------------------

export class MemorySessionBillRepository implements SessionBillRepository {
  private bills = new Map<string, SessionBillDTO>();

  async getBySessionId(sessionId: string): Promise<SessionBillDTO | null> {
    return this.bills.get(sessionId) ?? null;
  }

  async createFrozenBill(input: CreateFrozenBillInput): Promise<SessionBillDTO> {
    const existing = this.bills.get(input.session_id);
    if (existing) {
      // Mirrors the insert-only / unique-session-bill structural guarantee of
      // session_bills.session_id. The service already guards this; reaching
      // here is a programming error, not a domain path.
      throw new Error("session bill already frozen for this session");
    }
    const now = nowIso();
    const bill: SessionBillDTO = {
      id: randomUUID(),
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      food_subtotal: input.food_subtotal,
      packaging_fee: input.packaging_fee,
      gst_food: input.gst_food,
      gst_packaging: input.gst_packaging,
      total_amount: input.total_amount,
      frozen_at: now,
      created_at: now,
    };
    this.bills.set(bill.session_id, bill);
    return bill;
  }

  _reset(): void {
    this.bills.clear();
  }

  _seed(bill: SessionBillDTO): SessionBillDTO {
    this.bills.set(bill.session_id, bill);
    return bill;
  }

  /** Bill-id lookup for the vendor bill read model (DINE-OPS4-B1). Not part of
   *  the frozen SessionBillRepository contract (which reads by session_id);
   *  the in-memory map is keyed by session_id, so this scans the values. */
  async getById(billId: string): Promise<SessionBillDTO | null> {
    for (const bill of this.bills.values()) {
      if (bill.id === billId) return bill;
    }
    return null;
  }
}

// ------------------------------------------------------------
// Restaurant eligibility (narrow reader, frozen D2.4C).
// ------------------------------------------------------------

export class MemoryRestaurantEligibilityReader implements TransactionalRestaurantReader {
  private eligibility = new Map<string, RestaurantEligibilityDTO>();

  async getEligibility(
    restaurantId: string,
  ): Promise<RestaurantEligibilityDTO | null> {
    return this.eligibility.get(restaurantId) ?? null;
  }

  _reset(): void {
    this.eligibility.clear();
  }

  _seed(dto: RestaurantEligibilityDTO): RestaurantEligibilityDTO {
    this.eligibility.set(dto.id, dto);
    return dto;
  }
}

// ------------------------------------------------------------
// Memory transaction port + repo-set builder.
// ------------------------------------------------------------

export class MemoryDineInTransactionPort implements DineInTransactionPort {
  constructor(private readonly repos: DineInTransactionRepos) {}

  async runInTransaction<T>(
    fn: (repos: DineInTransactionRepos) => Promise<T>,
  ): Promise<T> {
    // No real rollback / isolation: the callback runs directly against the
    // shared in-memory set. D2.5I owns real-PG transaction guarantees.
    return fn(this.repos);
  }
}

export function buildMemoryDineInRepos(): DineInTransactionRepos {
  const restaurantTables = new MemoryRestaurantTableRepository();
  const diningSessions = new MemoryDiningSessionRepository();
  return {
    restaurantTables,
    diningSessions,
    staffAssignments: new MemoryStaffAssignmentRepository(),
    dineInOrders: new MemoryDineInOrderRepository(diningSessions, restaurantTables),
    serviceRequests: new MemoryServiceRequestRepository(diningSessions, restaurantTables),
    sessionBills: makeTxBoundSessionBill(new MemorySessionBillRepository()),
    restaurantEligibility: new MemoryRestaurantEligibilityReader(),
  };
}

export function buildMemoryDineInTransactionPort(): DineInTransactionPort {
  return new MemoryDineInTransactionPort(buildMemoryDineInRepos());
}

// ------------------------------------------------------------
// Vendor Dine-In bill read model (DINE-OPS4-B1, read-only, memory).
//
// The frozen bill half of the wire rows: SessionBillDTO minus created_at.
// ------------------------------------------------------------

function billTotals(bill: SessionBillDTO): VendorBillTotalsDTO {
  return {
    id: bill.id,
    session_id: bill.session_id,
    restaurant_id: bill.restaurant_id,
    food_subtotal: bill.food_subtotal,
    packaging_fee: bill.packaging_fee,
    gst_food: bill.gst_food,
    gst_packaging: bill.gst_packaging,
    total_amount: bill.total_amount,
    frozen_at: bill.frozen_at,
  };
}

export class MemoryDineInBillReadRepository implements DineInBillReadRepository {
  // Every read dependency is OPTIONAL for unit isolation; the memory
  // transaction-repo builder wires the SHARED instances so this read model
  // observes the SAME universe as the transaction services and the table
  // board. Zone names resolve through the shared table-board zone registry
  // (route tests seed it via _seedZone). Read-only — no mutation surface.
  constructor(
    private readonly tables?: MemoryRestaurantTableRepository,
    private readonly sessions?: MemoryDiningSessionRepository,
    private readonly orders?: MemoryDineInOrderRepository,
    private readonly requests?: MemoryServiceRequestRepository,
    private readonly bills?: MemorySessionBillRepository,
    private readonly board?: MemoryDineInTableBoardRepository,
  ) {}

  // Pre-auth discovery: the bill row only — no joins, no session/request
  // reads, no invariant checks (so the 404/403 precedence can never leak a
  // corrupted BILL_REQUESTED state before authorization).
  async getAccessContextByBillId(
    billId: string,
  ): Promise<BillAccessContext | null> {
    const bill = this.bills ? await this.bills.getById(billId) : null;
    if (!bill) return null;
    return {
      bill_id: bill.id,
      session_id: bill.session_id,
      restaurant_id: bill.restaurant_id,
    };
  }

  async getPendingQueueByRestaurant(
    restaurantId: string,
  ): Promise<VendorPendingBillRow[]> {
    if (!this.bills || !this.sessions || !this.requests || !this.tables) {
      return [];
    }
    const requests = (
      await this.requests.getPendingByRestaurant(restaurantId)
    ).filter((r) => r.request_type === "BRING_BILL");
    // Exactly-one BRING_BILL per session is the healthy state; defensively
    // keep the earliest matching request per session so a corrupted MULTIPLE
    // can never double-report the same bill on the queue.
    const earliestBySession = new Map<string, ServiceRequestDTO>();
    for (const request of requests) {
      const current = earliestBySession.get(request.session_id);
      if (
        !current ||
        request.created_at < current.created_at ||
        (request.created_at === current.created_at && request.id < current.id)
      ) {
        earliestBySession.set(request.session_id, request);
      }
    }

    const rows: VendorPendingBillRow[] = [];
    for (const request of earliestBySession.values()) {
      const session = await this.sessions.getById(request.session_id);
      if (!session || session.restaurant_id !== restaurantId) continue;
      // Queue membership: session BILL_REQUESTED + BRING_BILL PENDING/ACK.
      if (session.status !== "BILL_REQUESTED") continue;
      if (!BRING_BILL_QUEUE_STATUSES.includes(request.status)) continue;
      const bill = await this.bills.getBySessionId(session.id);
      if (!bill || bill.restaurant_id !== restaurantId) continue;
      const table = await this.tables.getById(session.table_id);
      if (!table || table.restaurant_id !== restaurantId) continue;
      rows.push({
        bill: billTotals(bill),
        session: {
          id: session.id,
          status: "BILL_REQUESTED",
          // Healthy BILL_REQUESTED always carries bill_requested_at (the
          // request-bill transition writes status + timestamp together); the
          // created_at fallback only keeps a corrupted row ordered.
          bill_requested_at: session.bill_requested_at ?? session.created_at,
          opened_at: session.created_at,
        },
        table: { id: table.id, label: table.label },
        bring_bill_request: {
          id: request.id,
          status: request.status as "PENDING" | "ACKNOWLEDGED",
        },
      });
    }

    rows.sort(
      (a, b) =>
        Date.parse(a.session.bill_requested_at) -
          Date.parse(b.session.bill_requested_at) ||
        a.bill.id.localeCompare(b.bill.id),
    );
    return rows;
  }

  // Post-auth detail read. While BILL_REQUESTED, the exactly-one BRING_BILL
  // invariant is enforced here (never before authorization).
  async getBillDetailByBillId(billId: string): Promise<VendorBillDetail | null> {
    if (!this.sessions || !this.requests || !this.tables) return null;
    const bill = this.bills ? await this.bills.getById(billId) : null;
    if (!bill) return null;
    const session = await this.sessions.getById(bill.session_id);
    if (session === null) {
      // Defensive structural corruption (FK forbids in postgres; mirrors the
      // service's INTERNAL_ERROR convention for a missing locked session).
      throw new AppError("INTERNAL_ERROR", "Frozen bill has no session", 500);
    }
    const lookup = await this.requests.findBringBillBySession(session.id);
    this.assertBringBillInvariant(session, lookup);
    const table = await this.tables.getById(session.table_id);
    if (table === null) {
      throw new AppError("INTERNAL_ERROR", "Frozen bill session has no table", 500);
    }
    const zone = table.zone_id
      ? (this.board?.getZoneById(table.zone_id) ?? null)
      : null;
    const orders = this.orders
      ? (await this.orders.getBySessionWithItems(session.id)).filter(
          // Same non-CANCELLED snapshot semantics as listForBill.
          (o) => o.status !== "CANCELLED",
        )
      : [];
    return {
      bill: billTotals(bill),
      session: {
        id: session.id,
        status: session.status,
        bill_requested_at: session.bill_requested_at,
        opened_at: session.created_at,
      },
      table: { id: table.id, label: table.label },
      zone,
      bring_bill_request: this.visibleBringBill(lookup),
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        created_at: o.created_at,
        items: o.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          item_subtotal: i.item_subtotal,
        })),
      })),
    };
  }

  // Post-auth action context. Session status is returned truthfully so the
  // route can enforce the BILL_REQUESTED action boundary (409) itself.
  async getBillActionContextByBillId(
    billId: string,
  ): Promise<BillActionContext | null> {
    if (!this.sessions || !this.requests) return null;
    const bill = this.bills ? await this.bills.getById(billId) : null;
    if (!bill) return null;
    const session = await this.sessions.getById(bill.session_id);
    if (session === null) {
      throw new AppError("INTERNAL_ERROR", "Frozen bill has no session", 500);
    }
    const lookup = await this.requests.findBringBillBySession(session.id);
    this.assertBringBillInvariant(session, lookup);
    return {
      session: { id: session.id, status: session.status },
      bring_bill_request:
        lookup.kind === "FOUND" &&
        BRING_BILL_VISIBLE_STATUSES.includes(lookup.value.status)
          ? { id: lookup.value.id, status: lookup.value.status }
          : null,
    };
  }

  // Admin live-session frozen-bill read (ADMIN-OPS1-A2): the session's frozen
  // bill snapshot or null. Read-only and invariant-free (never throws) — an
  // oversight read over DELIVERED-or-later bills, not the actionable vendor
  // queue, so no BILL_INVARIANT_VIOLATION and no payment/settlement state
  // invention. Unit-isolated (no sessions/orders/requests wired) -> null.
  async getFrozenBillBySessionId(
    sessionId: string,
  ): Promise<VendorBillTotalsDTO | null> {
    const bill = this.bills ? await this.bills.getBySessionId(sessionId) : null;
    return bill ? billTotals(bill) : null;
  }

  private assertBringBillInvariant(
    session: DiningSessionDTO,
    lookup: ArtifactLookup<ServiceRequestDTO>,
  ): void {
    // Frozen invariant: NONE and MULTIPLE both breach the exactly-one-artifact
    // rule. Enforced ONLY under BILL_REQUESTED and ONLY post-authorization.
    if (session.status === "BILL_REQUESTED" && lookup.kind !== "FOUND") {
      throw new AppError(
        "BILL_INVARIANT_VIOLATION",
        "BILL_REQUESTED session must have exactly one BRING_BILL request",
        500,
      );
    }
  }

  private visibleBringBill(
    lookup: ArtifactLookup<ServiceRequestDTO>,
  ): VendorBillDetail["bring_bill_request"] {
    if (
      lookup.kind !== "FOUND" ||
      !BRING_BILL_VISIBLE_STATUSES.includes(lookup.value.status)
    ) {
      return null;
    }
    return {
      id: lookup.value.id,
      status: lookup.value.status as "PENDING" | "ACKNOWLEDGED" | "COMPLETED",
      acknowledged_at: lookup.value.acknowledged_at,
      completed_at: lookup.value.completed_at,
    };
  }
}
