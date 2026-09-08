import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { AppError } from "../../middleware/envelope";
import {
  BRING_BILL_QUEUE_STATUSES,
  BRING_BILL_VISIBLE_STATUSES,
  KITCHEN_ORDER_STATUSES,
} from "../dineInContracts";
import {
  dine_in_order_items,
  dine_in_orders,
  dine_zones,
  dining_sessions,
  restaurants,
  restaurant_tables,
  service_requests,
  session_bills,
  staff_assignments,
} from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import type {
  DiningSessionStatus,
  DineInOrderStatus,
  ServiceRequestStatus,
  StaffAssignmentStatus,
} from "@snakzap/types";
import type {
  ArtifactLookup,
  BillAccessContext,
  BillActionContext,
  CreateDineInOrderInput,
  CreateDineZoneInput,
  CreateDiningSessionInput,
  CreateFrozenBillInput,
  CreateRestaurantTableInput,
  CreateServiceRequestInput,
  CreateStaffAssignmentInput,
  DiningSessionDTO,
  DineInBillReadRepository,
  DineInOrderDTO,
  DineInKitchenOrderDTO,
  DineInOrderItemDTO,
  DineInOrderWithItemsDTO,
  DineZoneDTO,
  RestaurantEligibilityDTO,
  RestaurantTableDTO,
  ServiceRequestDTO,
  ServiceRequestOperationsDTO,
  SessionBillDTO,
  StaffAssignmentDTO,
  TableResolveDTO,
  TableResolveRepository,
  TransitionResult,
  TransactionalDiningSessionRepository,
  TransactionalDineInOrderRepository,
  TransactionalRestaurantReader,
  TransactionalRestaurantTableRepository,
  TransactionalServiceRequestRepository,
  TransactionalStaffAssignmentRepository,
  DineZoneRepository,
  SessionBillRepository,
  DineInTableBoardReadRepository,
  VendorBillDetail,
  VendorBillTotalsDTO,
  VendorPendingBillRow,
  VendorTableBoardRow,
} from "../dineInContracts";

// ============================================
// Dine-In Drizzle/Postgres repositories.
// Implements the accepted D2.5A contracts only.
// Row locks are real PostgreSQL SELECT ... FOR UPDATE
// executed through the transaction-bound Drizzle facade.
// ============================================

const LIVE_SESSION_STATUSES: DiningSessionStatus[] = [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
];
const PENDING_REQUEST_STATUSES: ServiceRequestStatus[] = ["PENDING", "ACKNOWLEDGED"];
const CANCELLABLE_REQUEST_STATUSES: ServiceRequestStatus[] = ["PENDING", "ACKNOWLEDGED"];

// ------------------------------------------------------------
// Row mappers (decimal money normalized to number at the boundary).
// ------------------------------------------------------------

function mapTableRow(row: Record<string, unknown>): RestaurantTableDTO {
  return {
    id: row.id as string,
    restaurant_id: row.restaurant_id as string,
    zone_id: (row.zone_id as string | null) ?? null,
    label: row.label as string,
    table_token: row.table_token as string,
    seat_count: (row.seat_count as number | null) ?? null,
    is_active: row.is_active as boolean,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapZoneRow(row: Record<string, unknown>): DineZoneDTO {
  return {
    id: row.id as string,
    restaurant_id: row.restaurant_id as string,
    name: row.name as string,
    is_active: row.is_active as boolean,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapSessionRow(row: Record<string, unknown>): DiningSessionDTO {
  return {
    id: row.id as string,
    restaurant_id: row.restaurant_id as string,
    table_id: row.table_id as string,
    owner_user_id: row.owner_user_id as string,
    status: row.status as DiningSessionStatus,
    bill_requested_at: (row.bill_requested_at as Date | null)?.toISOString() ?? null,
    payment_pending_at: (row.payment_pending_at as Date | null)?.toISOString() ?? null,
    closed_at: (row.closed_at as Date | null)?.toISOString() ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapAssignmentRow(row: Record<string, unknown>): StaffAssignmentDTO {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    restaurant_id: row.restaurant_id as string,
    staff_user_id: row.staff_user_id as string,
    assigned_by: (row.assigned_by as string | null) ?? null,
    zone_id: (row.zone_id as string | null) ?? null,
    status: row.status as StaffAssignmentStatus,
    assigned_at: (row.assigned_at as Date).toISOString(),
    ended_at: (row.ended_at as Date | null)?.toISOString() ?? null,
  };
}

function mapOrderItemRow(row: Record<string, unknown>): DineInOrderItemDTO {
  return {
    id: row.id as string,
    dine_in_order_id: row.dine_in_order_id as string,
    restaurant_id: row.restaurant_id as string,
    menu_item_id: row.menu_item_id as string,
    name: row.name as string,
    base_price: Number(row.base_price),
    quantity: row.quantity as number,
    customizations: (row.customizations as DineInOrderItemDTO["customizations"]) ?? [],
    customization_total: Number(row.customization_total),
    item_subtotal: Number(row.item_subtotal),
    created_at: (row.created_at as Date).toISOString(),
  };
}

function mapOrderRow(
  row: Record<string, unknown>,
  items: DineInOrderItemDTO[],
): DineInOrderDTO {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    restaurant_id: row.restaurant_id as string,
    placed_by: row.placed_by as string,
    status: row.status as DineInOrderStatus,
    total_amount: Number(row.total_amount),
    notes: (row.notes as string | null) ?? null,
    served_at: (row.served_at as Date | null)?.toISOString() ?? null,
    cancelled_at: (row.cancelled_at as Date | null)?.toISOString() ?? null,
    cancelled_by: (row.cancelled_by as string | null) ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapRequestRow(row: Record<string, unknown>): ServiceRequestDTO {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    restaurant_id: row.restaurant_id as string,
    requested_by: row.requested_by as string,
    request_type: row.request_type as ServiceRequestDTO["request_type"],
    status: row.status as ServiceRequestStatus,
    note: (row.note as string | null) ?? null,
    acknowledged_by: (row.acknowledged_by as string | null) ?? null,
    acknowledged_at: (row.acknowledged_at as Date | null)?.toISOString() ?? null,
    completed_by: (row.completed_by as string | null) ?? null,
    completed_at: (row.completed_at as Date | null)?.toISOString() ?? null,
    cancelled_by: (row.cancelled_by as string | null) ?? null,
    cancelled_at: (row.cancelled_at as Date | null)?.toISOString() ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

function mapBillRow(row: Record<string, unknown>): SessionBillDTO {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    restaurant_id: row.restaurant_id as string,
    food_subtotal: Number(row.food_subtotal),
    packaging_fee: Number(row.packaging_fee),
    gst_food: Number(row.gst_food),
    gst_packaging: Number(row.gst_packaging),
    total_amount: Number(row.total_amount),
    frozen_at: (row.frozen_at as Date).toISOString(),
    created_at: (row.created_at as Date).toISOString(),
  };
}

function toDateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

// ------------------------------------------------------------
// Restaurant tables.
// ------------------------------------------------------------

export class DrizzleRestaurantTableRepository
  implements TransactionalRestaurantTableRepository, TableResolveRepository
{
  constructor(private db: DrizzleDb) {}

  async getById(tableId: string): Promise<RestaurantTableDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.id, tableId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapTableRow(row) : null;
  }

  async getByRestaurant(restaurantId: string): Promise<RestaurantTableDTO[]> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.restaurant_id, restaurantId))) as Record<string, unknown>[];
    return rows.map(mapTableRow);
  }

  async getByZone(zoneId: string): Promise<RestaurantTableDTO[]> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.zone_id, zoneId))) as Record<string, unknown>[];
    return rows.map(mapTableRow);
  }

  async findByToken(tableToken: string): Promise<RestaurantTableDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.table_token, tableToken))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapTableRow(row) : null;
  }

  // Public read-only resolve (frozen UI1-A-R1/R2). Informational only: no
  // FOR UPDATE, no transaction, no mutation, no reservation promise. Unknown
  // token / disabled table / inactive restaurant all collapse to null (the
  // not-found representation), identical to the openSession 404 collapse.
  async resolveByToken(tableToken: string): Promise<TableResolveDTO | null> {
    const tableRows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(
        and(
          eq(restaurant_tables.table_token, tableToken),
          eq(restaurant_tables.is_active, true),
        ),
      )) as Record<string, unknown>[];
    const tableRow = tableRows[0];
    if (!tableRow) return null;

    const restaurantRows = (await this.db
      .select()
      .from(restaurants)
      .where(
        and(
          eq(restaurants.id, tableRow.restaurant_id as string),
          eq(restaurants.is_active, true),
        ),
      )) as Record<string, unknown>[];
    const restaurantRow = restaurantRows[0];
    if (!restaurantRow) return null;

    return {
      restaurant: {
        id: restaurantRow.id as string,
        name: restaurantRow.name as string,
      },
      table: {
        id: tableRow.id as string,
        label: tableRow.label as string,
      },
      can_start_session: true,
    };
  }

  async create(input: CreateRestaurantTableInput): Promise<RestaurantTableDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(restaurant_tables).values({
      id,
      restaurant_id: input.restaurant_id,
      zone_id: input.zone_id ?? null,
      label: input.label,
      table_token: input.table_token,
      seat_count: input.seat_count ?? null,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    return {
      id,
      restaurant_id: input.restaurant_id,
      zone_id: input.zone_id ?? null,
      label: input.label,
      table_token: input.table_token,
      seat_count: input.seat_count ?? null,
      is_active: true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async setZone(tableId: string, zoneId: string | null): Promise<RestaurantTableDTO | null> {
    await this.db
      .update(restaurant_tables)
      .set({ zone_id: zoneId, updated_at: new Date() })
      .where(eq(restaurant_tables.id, tableId));
    return this.getById(tableId);
  }

  async setActive(tableId: string, isActive: boolean): Promise<RestaurantTableDTO | null> {
    await this.db
      .update(restaurant_tables)
      .set({ is_active: isActive, updated_at: new Date() })
      .where(eq(restaurant_tables.id, tableId));
    return this.getById(tableId);
  }

  async lockById(tableId: string): Promise<RestaurantTableDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.id, tableId))
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapTableRow(row) : null;
  }

  async lockByToken(tableToken: string): Promise<RestaurantTableDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.table_token, tableToken))
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapTableRow(row) : null;
  }
}

// ------------------------------------------------------------
// Dine zones.
// ------------------------------------------------------------

export class DrizzleDineZoneRepository implements DineZoneRepository {
  constructor(private db: DrizzleDb) {}

  async getById(zoneId: string): Promise<DineZoneDTO | null> {
    const rows = (await this.db
      .select()
      .from(dine_zones)
      .where(eq(dine_zones.id, zoneId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapZoneRow(row) : null;
  }

  async getByRestaurant(restaurantId: string): Promise<DineZoneDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_zones)
      .where(eq(dine_zones.restaurant_id, restaurantId))) as Record<string, unknown>[];
    return rows.map(mapZoneRow);
  }

  async getActive(restaurantId: string): Promise<DineZoneDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_zones)
      .where(and(eq(dine_zones.restaurant_id, restaurantId), eq(dine_zones.is_active, true)))) as Record<
      string,
      unknown
    >[];
    return rows.map(mapZoneRow);
  }

  async create(input: CreateDineZoneInput): Promise<DineZoneDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(dine_zones).values({
      id,
      restaurant_id: input.restaurant_id,
      name: input.name,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    return {
      id,
      restaurant_id: input.restaurant_id,
      name: input.name,
      is_active: true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async setActive(zoneId: string, isActive: boolean): Promise<DineZoneDTO | null> {
    await this.db
      .update(dine_zones)
      .set({ is_active: isActive, updated_at: new Date() })
      .where(eq(dine_zones.id, zoneId));
    return this.getById(zoneId);
  }

  async rename(zoneId: string, name: string): Promise<DineZoneDTO | null> {
    await this.db
      .update(dine_zones)
      .set({ name, updated_at: new Date() })
      .where(eq(dine_zones.id, zoneId));
    return this.getById(zoneId);
  }
}

// ------------------------------------------------------------
// Dining sessions.
// ------------------------------------------------------------

export class DrizzleDiningSessionRepository
  implements TransactionalDiningSessionRepository
{
  constructor(private db: DrizzleDb) {}

  async getById(sessionId: string): Promise<DiningSessionDTO | null> {
    const rows = (await this.db
      .select()
      .from(dining_sessions)
      .where(eq(dining_sessions.id, sessionId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async findLiveByTable(tableId: string): Promise<DiningSessionDTO | null> {
    const rows = (await this.db
      .select()
      .from(dining_sessions)
      .where(
        and(
          eq(dining_sessions.table_id, tableId),
          inArray(dining_sessions.status, LIVE_SESSION_STATUSES),
        ),
      )) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async getByTable(tableId: string): Promise<DiningSessionDTO[]> {
    const rows = (await this.db
      .select()
      .from(dining_sessions)
      .where(eq(dining_sessions.table_id, tableId))) as Record<string, unknown>[];
    return rows.map(mapSessionRow);
  }

  async create(input: CreateDiningSessionInput): Promise<DiningSessionDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(dining_sessions).values({
      id,
      restaurant_id: input.restaurant_id,
      table_id: input.table_id,
      owner_user_id: input.owner_user_id,
      status: "OPEN",
      created_at: now,
      updated_at: now,
    });
    return {
      id,
      restaurant_id: input.restaurant_id,
      table_id: input.table_id,
      owner_user_id: input.owner_user_id,
      status: "OPEN",
      bill_requested_at: null,
      payment_pending_at: null,
      closed_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async transitionStatus(
    sessionId: string,
    from: DiningSessionStatus,
    to: DiningSessionStatus,
    timestamps?: Partial<
      Pick<DiningSessionDTO, "bill_requested_at" | "payment_pending_at" | "closed_at">
    >,
  ): Promise<TransitionResult<DiningSessionDTO, DiningSessionStatus>> {
    const current = await this.getById(sessionId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== from) return { kind: "STATE_MISMATCH", current: current.status };
    await this.db
      .update(dining_sessions)
      .set({
        status: to,
        bill_requested_at: toDateOrNull(timestamps?.bill_requested_at),
        payment_pending_at: toDateOrNull(timestamps?.payment_pending_at),
        closed_at: toDateOrNull(timestamps?.closed_at),
        updated_at: new Date(),
      })
      .where(
        and(eq(dining_sessions.id, sessionId), eq(dining_sessions.status, from)),
      );
    return {
      kind: "UPDATED",
      value: {
        ...current,
        status: to,
        bill_requested_at: timestamps?.bill_requested_at ?? current.bill_requested_at,
        payment_pending_at:
          timestamps?.payment_pending_at ?? current.payment_pending_at,
        closed_at: timestamps?.closed_at ?? current.closed_at,
        updated_at: new Date().toISOString(),
      },
    };
  }

  async lockById(sessionId: string): Promise<DiningSessionDTO | null> {
    const rows = (await this.db
      .select()
      .from(dining_sessions)
      .where(eq(dining_sessions.id, sessionId))
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async lockLiveByTable(tableId: string): Promise<DiningSessionDTO | null> {
    const rows = (await this.db
      .select()
      .from(dining_sessions)
      .where(
        and(
          eq(dining_sessions.table_id, tableId),
          inArray(dining_sessions.status, LIVE_SESSION_STATUSES),
        ),
      )
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapSessionRow(row) : null;
  }
}

// ------------------------------------------------------------
// Staff assignments.
// ------------------------------------------------------------

export class DrizzleStaffAssignmentRepository
  implements TransactionalStaffAssignmentRepository
{
  constructor(private db: DrizzleDb) {}

  private async readById(
    assignmentId: string,
  ): Promise<StaffAssignmentDTO | null> {
    const rows = (await this.db
      .select()
      .from(staff_assignments)
      .where(eq(staff_assignments.id, assignmentId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapAssignmentRow(row) : null;
  }

  async getBySession(sessionId: string): Promise<StaffAssignmentDTO[]> {
    const rows = (await this.db
      .select()
      .from(staff_assignments)
      .where(eq(staff_assignments.session_id, sessionId))) as Record<string, unknown>[];
    return rows.map(mapAssignmentRow);
  }

  async getActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null> {
    const rows = (await this.db
      .select()
      .from(staff_assignments)
      .where(
        and(eq(staff_assignments.session_id, sessionId), eq(staff_assignments.status, "ACTIVE")),
      )) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapAssignmentRow(row) : null;
  }

  async getActiveByRestaurant(restaurantId: string): Promise<StaffAssignmentDTO[]> {
    const rows = (await this.db
      .select()
      .from(staff_assignments)
      .where(
        and(eq(staff_assignments.restaurant_id, restaurantId), eq(staff_assignments.status, "ACTIVE")),
      )) as Record<string, unknown>[];
    return rows.map(mapAssignmentRow);
  }

  async create(input: CreateStaffAssignmentInput): Promise<StaffAssignmentDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(staff_assignments).values({
      id,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      staff_user_id: input.staff_user_id,
      assigned_by: input.assigned_by ?? null,
      zone_id: input.zone_id ?? null,
      status: "ACTIVE",
      assigned_at: now,
    });
    return {
      id,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      staff_user_id: input.staff_user_id,
      assigned_by: input.assigned_by ?? null,
      zone_id: input.zone_id ?? null,
      status: "ACTIVE",
      assigned_at: now.toISOString(),
      ended_at: null,
    };
  }

  async endAssignment(
    assignmentId: string,
    endedAt: string,
  ): Promise<TransitionResult<StaffAssignmentDTO, StaffAssignmentStatus>> {
    const current = await this.readById(assignmentId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "ACTIVE") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    await this.db
      .update(staff_assignments)
      .set({ status: "ENDED", ended_at: new Date(endedAt) })
      .where(
        and(eq(staff_assignments.id, assignmentId), eq(staff_assignments.status, "ACTIVE")),
      );
    return {
      kind: "UPDATED",
      value: { ...current, status: "ENDED", ended_at: new Date(endedAt).toISOString() },
    };
  }

  async lockActiveBySession(sessionId: string): Promise<StaffAssignmentDTO | null> {
    const rows = (await this.db
      .select()
      .from(staff_assignments)
      .where(
        and(eq(staff_assignments.session_id, sessionId), eq(staff_assignments.status, "ACTIVE")),
      )
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapAssignmentRow(row) : null;
  }
}

// ------------------------------------------------------------
// Dine-in orders + order items.
// ------------------------------------------------------------

export class DrizzleDineInOrderRepository
  implements TransactionalDineInOrderRepository
{
  constructor(private db: DrizzleDb) {}

  private async loadItems(orderId: string): Promise<DineInOrderItemDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_in_order_items)
      .where(eq(dine_in_order_items.dine_in_order_id, orderId))) as Record<
      string,
      unknown
    >[];
    return rows.map(mapOrderItemRow);
  }

  async getById(orderId: string): Promise<DineInOrderDTO | null> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(eq(dine_in_orders.id, orderId))) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    return mapOrderRow(row, await this.loadItems(orderId));
  }

  async getBySession(sessionId: string): Promise<DineInOrderDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(eq(dine_in_orders.session_id, sessionId))) as Record<string, unknown>[];
    const results: DineInOrderDTO[] = [];
    for (const row of rows) {
      results.push(mapOrderRow(row, await this.loadItems(row.id as string)));
    }
    return results;
  }

  async getBySessionWithItems(sessionId: string): Promise<DineInOrderWithItemsDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(eq(dine_in_orders.session_id, sessionId))) as Record<string, unknown>[];
    const results: DineInOrderWithItemsDTO[] = [];
    for (const row of rows) {
      const items = await this.loadItems(row.id as string);
      results.push({ ...mapOrderRow(row, items), items });
    }
    return results;
  }

  async create(input: CreateDineInOrderInput): Promise<DineInOrderDTO> {
    const now = new Date();
    const orderId = randomUUID();
    await this.db.insert(dine_in_orders).values({
      id: orderId,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      placed_by: input.placed_by,
      status: "PLACED",
      total_amount: String(input.total_amount),
      notes: input.notes ?? null,
      served_at: null,
      cancelled_at: null,
      cancelled_by: null,
      created_at: now,
      updated_at: now,
    });
    for (const item of input.items) {
      await this.db.insert(dine_in_order_items).values({
        id: randomUUID(),
        dine_in_order_id: orderId,
        restaurant_id: input.restaurant_id,
        menu_item_id: item.menu_item_id,
        name: item.name,
        base_price: String(item.base_price),
        quantity: item.quantity,
        customizations: item.customizations,
        customization_total: String(item.customization_total),
        item_subtotal: String(item.item_subtotal),
        created_at: now,
      });
    }
    return {
      id: orderId,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      placed_by: input.placed_by,
      status: "PLACED",
      total_amount: input.total_amount,
      notes: input.notes ?? null,
      served_at: null,
      cancelled_at: null,
      cancelled_by: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async transitionStatus(
    orderId: string,
    from: DineInOrderStatus,
    to: DineInOrderStatus,
    metadata?: { cancelled_by?: string; cancelled_at?: string; served_at?: string },
  ): Promise<TransitionResult<DineInOrderDTO, DineInOrderStatus>> {
    const current = await this.getById(orderId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== from) return { kind: "STATE_MISMATCH", current: current.status };
    await this.db
      .update(dine_in_orders)
      .set({
        status: to,
        cancelled_by: metadata?.cancelled_by,
        cancelled_at: metadata?.cancelled_at
          ? new Date(metadata.cancelled_at)
          : undefined,
        served_at:
          to === "SERVED" && metadata?.served_at
            ? new Date(metadata.served_at)
            : undefined,
        updated_at: new Date(),
      })
      .where(and(eq(dine_in_orders.id, orderId), eq(dine_in_orders.status, from)));
    return {
      kind: "UPDATED",
      value: {
        ...current,
        status: to,
        cancelled_by: metadata?.cancelled_by ?? current.cancelled_by,
        cancelled_at: metadata?.cancelled_at ?? current.cancelled_at,
        served_at:
          to === "SERVED" && metadata?.served_at
            ? metadata.served_at
            : current.served_at,
        updated_at: new Date().toISOString(),
      },
    };
  }

  async listForBill(sessionId: string): Promise<DineInOrderWithItemsDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(
        and(
          eq(dine_in_orders.session_id, sessionId),
          ne(dine_in_orders.status, "CANCELLED"),
        ),
      )) as Record<string, unknown>[];
    const results: DineInOrderWithItemsDTO[] = [];
    for (const row of rows) {
      const items = await this.loadItems(row.id as string);
      results.push({ ...mapOrderRow(row, items), items });
    }
    return results;
  }

  async getKitchenQueueByRestaurant(
    restaurantId: string,
  ): Promise<DineInKitchenOrderDTO[]> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(
        and(
          eq(dine_in_orders.restaurant_id, restaurantId),
          inArray(dine_in_orders.status, KITCHEN_ORDER_STATUSES),
        ),
      )) as Record<string, unknown>[];
    rows.sort(
      (a, b) =>
        new Date(a.created_at as Date).getTime() -
        new Date(b.created_at as Date).getTime(),
    );
    const results: DineInKitchenOrderDTO[] = [];
    for (const row of rows) {
      const orderId = row.id as string;
      const items = await this.loadItems(orderId);
      const sessionRows = (await this.db
        .select()
        .from(dining_sessions)
        .where(eq(dining_sessions.id, row.session_id as string))) as Record<
        string,
        unknown
      >[];
      const session = sessionRows[0];
      let table: { id: string; label: string } = { id: "", label: "" };
      if (session) {
        const tableRows = (await this.db
          .select()
          .from(restaurant_tables)
          .where(eq(restaurant_tables.id, session.table_id as string))) as Record<
          string,
          unknown
        >[];
        if (tableRows[0]) {
          table = {
            id: tableRows[0].id as string,
            label: tableRows[0].label as string,
          };
        }
      }
      results.push({
        id: orderId,
        session_id: row.session_id as string,
        status: row.status as DineInOrderStatus,
        total_amount: Number(row.total_amount),
        created_at: (row.created_at as Date).toISOString(),
        table,
        items: items.map((i) => ({
          menu_item_id: i.menu_item_id,
          name: i.name,
          quantity: i.quantity,
          item_subtotal: i.item_subtotal,
        })),
      });
    }
    return results;
  }

  async lockById(orderId: string): Promise<DineInOrderDTO | null> {
    const rows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(eq(dine_in_orders.id, orderId))
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    return mapOrderRow(row, await this.loadItems(orderId));
  }
}

// ------------------------------------------------------------
// Service requests.
// ------------------------------------------------------------

export class DrizzleServiceRequestRepository
  implements TransactionalServiceRequestRepository
{
  constructor(private db: DrizzleDb) {}

  async getById(requestId: string): Promise<ServiceRequestDTO | null> {
    const rows = (await this.db
      .select()
      .from(service_requests)
      .where(eq(service_requests.id, requestId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapRequestRow(row) : null;
  }

  async getBySession(sessionId: string): Promise<ServiceRequestDTO[]> {
    const rows = (await this.db
      .select()
      .from(service_requests)
      .where(eq(service_requests.session_id, sessionId))) as Record<string, unknown>[];
    return rows.map(mapRequestRow);
  }

  async getPendingByRestaurant(restaurantId: string): Promise<ServiceRequestDTO[]> {
    const rows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.restaurant_id, restaurantId),
          inArray(service_requests.status, PENDING_REQUEST_STATUSES),
        ),
      )) as Record<string, unknown>[];
    return rows
      .map(mapRequestRow)
      .sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
  }

  // DINE-OPS2 vendor operations queue. Mirrors the DINE-OPS1.2 kitchen-queue
  // read-model shape: status filter at the SQL boundary, oldest-first, and the
  // table identity DERIVED from the owning session -> restaurant table (never
  // client-supplied). BRING_BILL is excluded because the billing flow owns
  // that artifact.
  //
  // Query shape: a BOUNDED fixed-query fetch (no per-row DB calls). The
  // DrizzleDb facade (lib/dbType.ts) deliberately exposes only
  // select/where — no join/orderBy surface — so a literal SQL JOIN is not
  // expressible inside the repository without widening the shared facade
  // (outside this bounded context). Instead the session/table resolution uses
  // two inArray-batched lookups (1 requests query + 1 sessions query + 1
  // tables query, regardless of queue size). Ordering is deterministic in
  // memory: (created_at ASC, id ASC). A request whose session/table cannot be
  // resolved is OMITTED (inner-join semantics) — never surfaced with an empty
  // fake table identity.
  async getOperationsQueueByRestaurant(
    restaurantId: string,
  ): Promise<ServiceRequestOperationsDTO[]> {
    const reqRows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.restaurant_id, restaurantId),
          inArray(service_requests.status, PENDING_REQUEST_STATUSES),
          ne(service_requests.request_type, "BRING_BILL"),
        ),
      )) as Record<string, unknown>[];

    const sessionIds = [
      ...new Set(reqRows.map((r) => r.session_id as string)),
    ];
    const sessionRows = sessionIds.length
      ? ((await this.db
          .select()
          .from(dining_sessions)
          .where(inArray(dining_sessions.id, sessionIds))) as Record<
          string,
          unknown
        >[])
      : [];
    const sessionsById = new Map(
      sessionRows.map((s) => [s.id as string, s]),
    );

    const tableIds = [
      ...new Set(
        sessionRows
          .map((s) => s.table_id as string)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    const tableRows = tableIds.length
      ? ((await this.db
          .select()
          .from(restaurant_tables)
          .where(inArray(restaurant_tables.id, tableIds))) as Record<
          string,
          unknown
        >[])
      : [];
    const tablesById = new Map(tableRows.map((t) => [t.id as string, t]));

    reqRows.sort(
      (a, b) =>
        new Date(a.created_at as Date).getTime() -
          new Date(b.created_at as Date).getTime() ||
        (a.id as string).localeCompare(b.id as string),
    );
    const results: ServiceRequestOperationsDTO[] = [];
    for (const row of reqRows) {
      const request = mapRequestRow(row);
      const session = sessionsById.get(request.session_id);
      const table = session
        ? tablesById.get(session.table_id as string)
        : undefined;
      if (!session || !table) {
        // Inner-join semantics: no resolvable server-derived table identity
        // -> the row is not part of the actionable queue.
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
        table: { id: table.id as string, label: table.label as string },
      });
    }
    return results;
  }

  async create(input: CreateServiceRequestInput): Promise<ServiceRequestDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(service_requests).values({
      id,
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
    });
    return {
      id,
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
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  }

  async acknowledge(
    requestId: string,
    acknowledgedBy: string,
    acknowledgedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = await this.getById(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "PENDING") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    await this.db
      .update(service_requests)
      .set({
        status: "ACKNOWLEDGED",
        acknowledged_by: acknowledgedBy,
        acknowledged_at: new Date(acknowledgedAt),
        updated_at: new Date(),
      })
      .where(
        and(eq(service_requests.id, requestId), eq(service_requests.status, "PENDING")),
      );
    return {
      kind: "UPDATED",
      value: {
        ...current,
        status: "ACKNOWLEDGED",
        acknowledged_by: acknowledgedBy,
        acknowledged_at: acknowledgedAt,
        updated_at: new Date().toISOString(),
      },
    };
  }

  async complete(
    requestId: string,
    completedBy: string,
    completedAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = await this.getById(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (current.status !== "ACKNOWLEDGED") {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    await this.db
      .update(service_requests)
      .set({
        status: "COMPLETED",
        completed_by: completedBy,
        completed_at: new Date(completedAt),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(service_requests.id, requestId),
          eq(service_requests.status, "ACKNOWLEDGED"),
        ),
      );
    return {
      kind: "UPDATED",
      value: {
        ...current,
        status: "COMPLETED",
        completed_by: completedBy,
        completed_at: completedAt,
        updated_at: new Date().toISOString(),
      },
    };
  }

  async cancel(
    requestId: string,
    cancelledBy: string,
    cancelledAt: string,
  ): Promise<TransitionResult<ServiceRequestDTO, ServiceRequestStatus>> {
    const current = await this.getById(requestId);
    if (!current) return { kind: "NOT_FOUND" };
    if (!CANCELLABLE_REQUEST_STATUSES.includes(current.status)) {
      return { kind: "STATE_MISMATCH", current: current.status };
    }
    await this.db
      .update(service_requests)
      .set({
        status: "CANCELLED",
        cancelled_by: cancelledBy,
        cancelled_at: new Date(cancelledAt),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(service_requests.id, requestId),
          inArray(service_requests.status, CANCELLABLE_REQUEST_STATUSES),
        ),
      );
    return {
      kind: "UPDATED",
      value: {
        ...current,
        status: "CANCELLED",
        cancelled_by: cancelledBy,
        cancelled_at: cancelledAt,
        updated_at: new Date().toISOString(),
      },
    };
  }

  async findBringBillBySession(
    sessionId: string,
  ): Promise<ArtifactLookup<ServiceRequestDTO>> {
    const rows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.session_id, sessionId),
          eq(service_requests.request_type, "BRING_BILL"),
        ),
      )) as Record<string, unknown>[];
    if (rows.length === 0) return { kind: "NONE" };
    if (rows.length === 1) {
      return { kind: "FOUND", value: mapRequestRow(rows[0]!) };
    }
    return { kind: "MULTIPLE", values: rows.map(mapRequestRow) };
  }

  async lockById(requestId: string): Promise<ServiceRequestDTO | null> {
    const rows = (await this.db
      .select()
      .from(service_requests)
      .where(eq(service_requests.id, requestId))
      .for("update")) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapRequestRow(row) : null;
  }
}

// ------------------------------------------------------------
// Session bills (insert-only, immutable).
// ------------------------------------------------------------

export class DrizzleSessionBillRepository implements SessionBillRepository {
  constructor(private db: DrizzleDb) {}

  async getBySessionId(sessionId: string): Promise<SessionBillDTO | null> {
    const rows = (await this.db
      .select()
      .from(session_bills)
      .where(eq(session_bills.session_id, sessionId))) as Record<string, unknown>[];
    const row = rows[0];
    return row ? mapBillRow(row) : null;
  }

  async createFrozenBill(input: CreateFrozenBillInput): Promise<SessionBillDTO> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(session_bills).values({
      id,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      food_subtotal: String(input.food_subtotal),
      packaging_fee: String(input.packaging_fee),
      gst_food: String(input.gst_food),
      gst_packaging: String(input.gst_packaging),
      total_amount: String(input.total_amount),
      frozen_at: now,
      created_at: now,
    });
    return {
      id,
      session_id: input.session_id,
      restaurant_id: input.restaurant_id,
      food_subtotal: input.food_subtotal,
      packaging_fee: input.packaging_fee,
      gst_food: input.gst_food,
      gst_packaging: input.gst_packaging,
      total_amount: input.total_amount,
      frozen_at: now.toISOString(),
      created_at: now.toISOString(),
    };
  }
}

// ------------------------------------------------------------
// Restaurant eligibility (narrow reader, frozen D2.4C).
// ------------------------------------------------------------

export class DrizzleRestaurantEligibilityReader implements TransactionalRestaurantReader {
  constructor(private db: DrizzleDb) {}

  async getEligibility(
    restaurantId: string,
  ): Promise<RestaurantEligibilityDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, restaurantId))) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    return { id: row.id as string, is_active: row.is_active as boolean };
  }
}

// ------------------------------------------------------------
// Dine-in table/session board (DINE-OPS3, read-only).
// ------------------------------------------------------------

// DINE-OPS3 vendor occupancy board: a dedicated read model so the route
// performs no joins / no N+1. Every restaurant table (including disabled
// tables) is returned with the server-derived live session — the
// single-live-session invariant means at most one per table — and the
// actionable open-order (PLACED/PREPARING/READY_TO_SERVE) and open-request
// (PENDING/ACKNOWLEDGED, EXCLUDING BRING_BILL) counts.
//
// Query shape: a BOUNDED fixed query set (1 tables + 1 zones + 1 live
// sessions + 1 orders + 1 requests, regardless of table count) — no per-row
// DB calls, mirroring the kitchen/SR read-model facade constraint (the
// DrizzleDb facade exposes only select/where). Zone name, live-session, and
// counts are resolved from those bounded sets in memory. A table whose
// zone_id does not resolve to a zone row is surfaced with zone: null
// (truthful — no fake zone). A disabled table that still carries a live
// session reports BOTH facts (is_active false + session present).
// Ordering is deterministic: (label ASC, id ASC).
export class DrizzleDineInTableBoardRepository
  implements DineInTableBoardReadRepository
{
  constructor(private db: DrizzleDb) {}

  async getByRestaurant(restaurantId: string): Promise<VendorTableBoardRow[]> {
    const tableRows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.restaurant_id, restaurantId))) as Record<
      string,
      unknown
    >[];
    const zoneRows = (await this.db
      .select()
      .from(dine_zones)
      .where(eq(dine_zones.restaurant_id, restaurantId))) as Record<
      string,
      unknown
    >[];
    const sessionRows = (await this.db
      .select()
      .from(dining_sessions)
      .where(
        and(
          eq(dining_sessions.restaurant_id, restaurantId),
          inArray(dining_sessions.status, LIVE_SESSION_STATUSES),
        ),
      )) as Record<string, unknown>[];

    const liveSessionIds = [
      ...new Set(sessionRows.map((s) => s.id as string)),
    ];
    const orderRows = liveSessionIds.length
      ? ((await this.db
          .select()
          .from(dine_in_orders)
          .where(
            and(
              eq(dine_in_orders.restaurant_id, restaurantId),
              inArray(dine_in_orders.session_id, liveSessionIds),
              inArray(dine_in_orders.status, KITCHEN_ORDER_STATUSES),
            ),
          )) as Record<string, unknown>[])
      : [];
    const requestRows = liveSessionIds.length
      ? ((await this.db
          .select()
          .from(service_requests)
          .where(
            and(
              eq(service_requests.restaurant_id, restaurantId),
              inArray(service_requests.session_id, liveSessionIds),
              inArray(service_requests.status, PENDING_REQUEST_STATUSES),
              ne(service_requests.request_type, "BRING_BILL"),
            ),
          )) as Record<string, unknown>[])
      : [];

    const zonesById = new Map<string, { id: string; name: string }>(
      zoneRows.map((z) => [
        z.id as string,
        { id: z.id as string, name: z.name as string },
      ]),
    );

    // Single-live-session invariant -> at most one live session per table;
    // keep the first row defensively if the invariant were ever violated.
    const liveByTableId = new Map<string, Record<string, unknown>>();
    for (const s of sessionRows) {
      const tableId = s.table_id as string;
      if (!liveByTableId.has(tableId)) liveByTableId.set(tableId, s);
    }

    const openOrderCounts = new Map<string, number>();
    for (const o of orderRows) {
      const sessionId = o.session_id as string;
      openOrderCounts.set(sessionId, (openOrderCounts.get(sessionId) ?? 0) + 1);
    }
    const openRequestCounts = new Map<string, number>();
    for (const r of requestRows) {
      const sessionId = r.session_id as string;
      openRequestCounts.set(sessionId, (openRequestCounts.get(sessionId) ?? 0) + 1);
    }

    const rows: VendorTableBoardRow[] = [];
    for (const t of tableRows) {
      const zoneId = t.zone_id as string | null;
      const live = liveByTableId.get(t.id as string);
      rows.push({
        table: {
          id: t.id as string,
          label: t.label as string,
          seat_count: (t.seat_count as number | null) ?? null,
          is_active: t.is_active as boolean,
        },
        zone: zoneId ? (zonesById.get(zoneId) ?? null) : null,
        session: live
          ? {
              id: live.id as string,
              status: live.status as DiningSessionStatus,
              opened_at: (live.created_at as Date).toISOString(),
              bill_requested_at:
                (live.bill_requested_at as Date | null)?.toISOString() ?? null,
            }
          : null,
        open_order_count: live
          ? (openOrderCounts.get(live.id as string) ?? 0)
          : 0,
        open_request_count: live
          ? (openRequestCounts.get(live.id as string) ?? 0)
          : 0,
      });
    }

    rows.sort(
      (a, b) =>
        a.table.label.localeCompare(b.table.label) ||
        a.table.id.localeCompare(b.table.id),
    );
    return rows;
  }
}

// ------------------------------------------------------------
// Vendor Dine-In bill read model (DINE-OPS4-B1, read-only).
//
// DINE-OPS4-B1 vendor bill surface: a dedicated read model so the routes
// perform no joins / no N+1. Query shape is a BOUNDED fixed query set per
// call (like the table board), regardless of row count:
//   - getPendingQueueByRestaurant: 1 requests + 1 sessions + 1 bills + 1
//     tables for the restaurant.
//   - getBillDetailByBillId / getBillActionContextByBillId: bill + session +
//     bring-bill requests + table (+ zone + orders + order items for detail).
//
// Queue membership: session.status === "BILL_REQUESTED" AND the session's
// BRING_BILL artifact is PENDING/ACKNOWLEDGED; ordering bill_requested_at ASC
// then bill.id ASC. A delivered (COMPLETED) artifact leaves the queue while
// the bill detail stays readable. The frozen exactly-one-BRING_BILL invariant
// is enforced ONLY inside the post-authorization reads below (BILL_REQUESTED
// with NONE/MULTIPLE -> BILL_INVARIANT_VIOLATION 500); getAccessContextByBillId
// is invariant-free discovery so the 404/403 precedence never leaks a
// corrupted state before authorization. Read-only — no mutation surface.
// ------------------------------------------------------------

function mapBillTotalsRow(row: Record<string, unknown>): VendorBillTotalsDTO {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    restaurant_id: row.restaurant_id as string,
    food_subtotal: Number(row.food_subtotal),
    packaging_fee: Number(row.packaging_fee),
    gst_food: Number(row.gst_food),
    gst_packaging: Number(row.gst_packaging),
    total_amount: Number(row.total_amount),
    frozen_at: (row.frozen_at as Date).toISOString(),
  };
}

function serviceRequestLookup(
  rows: Record<string, unknown>[],
): ArtifactLookup<ServiceRequestDTO> {
  if (rows.length === 0) return { kind: "NONE" };
  if (rows.length === 1) {
    return { kind: "FOUND", value: mapRequestRow(rows[0]!) };
  }
  return { kind: "MULTIPLE", values: rows.map(mapRequestRow) };
}

export class DrizzleDineInBillReadRepository
  implements DineInBillReadRepository
{
  constructor(private db: DrizzleDb) {}

  async getAccessContextByBillId(
    billId: string,
  ): Promise<BillAccessContext | null> {
    const rows = (await this.db
      .select()
      .from(session_bills)
      .where(eq(session_bills.id, billId))) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    return {
      bill_id: row.id as string,
      session_id: row.session_id as string,
      restaurant_id: row.restaurant_id as string,
    };
  }

  async getPendingQueueByRestaurant(
    restaurantId: string,
  ): Promise<VendorPendingBillRow[]> {
    const requestRows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.restaurant_id, restaurantId),
          eq(service_requests.request_type, "BRING_BILL"),
          inArray(service_requests.status, BRING_BILL_QUEUE_STATUSES),
        ),
      )) as Record<string, unknown>[];
    const requestSessionIds = [
      ...new Set(requestRows.map((r) => r.session_id as string)),
    ];
    const sessionRows = requestSessionIds.length
      ? ((await this.db
          .select()
          .from(dining_sessions)
          .where(inArray(dining_sessions.id, requestSessionIds))) as Record<
          string,
          unknown
        >[])
      : [];
    const billRequestedSessionIds = sessionRows
      .filter((s) => (s.status as string) === "BILL_REQUESTED")
      .map((s) => s.id as string);
    const billRows = billRequestedSessionIds.length
      ? ((await this.db
          .select()
          .from(session_bills)
          .where(
            and(
              eq(session_bills.restaurant_id, restaurantId),
              inArray(session_bills.session_id, billRequestedSessionIds),
            ),
          )) as Record<string, unknown>[])
      : [];
    const tableIds = [
      ...new Set(sessionRows.map((s) => s.table_id as string)),
    ];
    const tableRows = tableIds.length
      ? ((await this.db
          .select()
          .from(restaurant_tables)
          .where(inArray(restaurant_tables.id, tableIds))) as Record<
          string,
          unknown
        >[])
      : [];

    const sessionById = new Map<string, Record<string, unknown>>(
      sessionRows.map((s) => [s.id as string, s]),
    );
    const billBySessionId = new Map<string, Record<string, unknown>>(
      billRows.map((b) => [b.session_id as string, b]),
    );
    const tableById = new Map<string, Record<string, unknown>>(
      tableRows.map((t) => [t.id as string, t]),
    );
    // Exactly-one BRING_BILL per session is the healthy state; defensively
    // keep the earliest matching request per session so a corrupted MULTIPLE
    // can never double-report the same bill on the queue.
    const earliestBySession = new Map<string, Record<string, unknown>>();
    for (const request of requestRows) {
      const sessionId = request.session_id as string;
      const current = earliestBySession.get(sessionId);
      const requestTime = (request.created_at as Date).getTime();
      const currentTime = current
        ? (current.created_at as Date).getTime()
        : Infinity;
      if (
        !current ||
        requestTime < currentTime ||
        (requestTime === currentTime &&
          (request.id as string) < (current.id as string))
      ) {
        earliestBySession.set(sessionId, request);
      }
    }

    const rows: VendorPendingBillRow[] = [];
    for (const request of earliestBySession.values()) {
      const session = sessionById.get(request.session_id as string);
      if (!session || (session.status as string) !== "BILL_REQUESTED") continue;
      const bill = billBySessionId.get(session.id as string);
      if (!bill) continue;
      const table = tableById.get(session.table_id as string);
      if (!table) continue;
      rows.push({
        bill: mapBillTotalsRow(bill),
        session: {
          id: session.id as string,
          status: "BILL_REQUESTED",
          // Healthy BILL_REQUESTED always carries bill_requested_at (the
          // request-bill transition writes status + timestamp together); the
          // created_at fallback only keeps a corrupted row ordered.
          bill_requested_at:
            (session.bill_requested_at as Date | null)?.toISOString() ??
            (session.created_at as Date).toISOString(),
          opened_at: (session.created_at as Date).toISOString(),
        },
        table: {
          id: table.id as string,
          label: table.label as string,
        },
        bring_bill_request: {
          id: request.id as string,
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

  async getBillDetailByBillId(billId: string): Promise<VendorBillDetail | null> {
    const billRows = (await this.db
      .select()
      .from(session_bills)
      .where(eq(session_bills.id, billId))) as Record<string, unknown>[];
    const billRow = billRows[0];
    if (!billRow) return null;
    const sessionId = billRow.session_id as string;

    const sessionRows = (await this.db
      .select()
      .from(dining_sessions)
      .where(eq(dining_sessions.id, sessionId))) as Record<string, unknown>[];
    const session = sessionRows[0];
    if (!session) {
      // Defensive structural corruption (FK forbids in postgres; mirrors the
      // service's INTERNAL_ERROR convention for a missing locked session).
      throw new AppError("INTERNAL_ERROR", "Frozen bill has no session", 500);
    }

    const bringBillRows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.session_id, sessionId),
          eq(service_requests.request_type, "BRING_BILL"),
        ),
      )) as Record<string, unknown>[];
    const lookup = serviceRequestLookup(bringBillRows);
    // Frozen invariant: NONE and MULTIPLE both breach the exactly-one-artifact
    // rule. Enforced ONLY under BILL_REQUESTED and ONLY post-authorization.
    if (
      (session.status as string) === "BILL_REQUESTED" &&
      lookup.kind !== "FOUND"
    ) {
      throw new AppError(
        "BILL_INVARIANT_VIOLATION",
        "BILL_REQUESTED session must have exactly one BRING_BILL request",
        500,
      );
    }

    const tableRows = (await this.db
      .select()
      .from(restaurant_tables)
      .where(eq(restaurant_tables.id, session.table_id as string))) as Record<
      string,
      unknown
    >[];
    const table = tableRows[0];
    if (!table) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Frozen bill session has no table",
        500,
      );
    }
    const zoneId = (table.zone_id as string | null) ?? null;
    const zoneRows = zoneId
      ? ((await this.db
          .select()
          .from(dine_zones)
          .where(eq(dine_zones.id, zoneId))) as Record<string, unknown>[])
      : [];
    const zoneRow = zoneRows[0] ?? null;

    const orderRows = (await this.db
      .select()
      .from(dine_in_orders)
      .where(
        and(
          eq(dine_in_orders.session_id, sessionId),
          // Same non-CANCELLED snapshot semantics as listForBill.
          ne(dine_in_orders.status, "CANCELLED"),
        ),
      )) as Record<string, unknown>[];
    const orderIds = orderRows.map((o) => o.id as string);
    const itemRows = orderIds.length
      ? ((await this.db
          .select()
          .from(dine_in_order_items)
          .where(
            inArray(dine_in_order_items.dine_in_order_id, orderIds),
          )) as Record<string, unknown>[])
      : [];
    const itemsByOrderId = new Map<string, VendorBillDetail["orders"][number]["items"]>();
    for (const item of itemRows) {
      const orderId = item.dine_in_order_id as string;
      const list = itemsByOrderId.get(orderId) ?? [];
      list.push({
        name: item.name as string,
        quantity: item.quantity as number,
        item_subtotal: Number(item.item_subtotal),
      });
      itemsByOrderId.set(orderId, list);
    }

    return {
      bill: mapBillTotalsRow(billRow),
      session: {
        id: session.id as string,
        status: session.status as DiningSessionStatus,
        bill_requested_at:
          (session.bill_requested_at as Date | null)?.toISOString() ?? null,
        opened_at: (session.created_at as Date).toISOString(),
      },
      table: { id: table.id as string, label: table.label as string },
      zone: zoneRow
        ? { id: zoneRow.id as string, name: zoneRow.name as string }
        : null,
      bring_bill_request: this.visibleBringBill(lookup),
      orders: orderRows.map((o) => ({
        id: o.id as string,
        status: o.status as DineInOrderStatus,
        created_at: (o.created_at as Date).toISOString(),
        items: itemsByOrderId.get(o.id as string) ?? [],
      })),
    };
  }

  async getBillActionContextByBillId(
    billId: string,
  ): Promise<BillActionContext | null> {
    const billRows = (await this.db
      .select()
      .from(session_bills)
      .where(eq(session_bills.id, billId))) as Record<string, unknown>[];
    const billRow = billRows[0];
    if (!billRow) return null;
    const sessionId = billRow.session_id as string;

    const sessionRows = (await this.db
      .select()
      .from(dining_sessions)
      .where(eq(dining_sessions.id, sessionId))) as Record<string, unknown>[];
    const session = sessionRows[0];
    if (!session) {
      throw new AppError("INTERNAL_ERROR", "Frozen bill has no session", 500);
    }

    const bringBillRows = (await this.db
      .select()
      .from(service_requests)
      .where(
        and(
          eq(service_requests.session_id, sessionId),
          eq(service_requests.request_type, "BRING_BILL"),
        ),
      )) as Record<string, unknown>[];
    const lookup = serviceRequestLookup(bringBillRows);
    if (
      (session.status as string) === "BILL_REQUESTED" &&
      lookup.kind !== "FOUND"
    ) {
      throw new AppError(
        "BILL_INVARIANT_VIOLATION",
        "BILL_REQUESTED session must have exactly one BRING_BILL request",
        500,
      );
    }

    return {
      session: {
        id: session.id as string,
        status: session.status as DiningSessionStatus,
      },
      bring_bill_request:
        lookup.kind === "FOUND" &&
        BRING_BILL_VISIBLE_STATUSES.includes(lookup.value.status)
          ? { id: lookup.value.id, status: lookup.value.status }
          : null,
    };
  }

  // Admin live-session frozen-bill read (ADMIN-OPS1-A2): the session's frozen
  // bill snapshot or null (session_id -> session_bills direct lookup, single
  // bounded select). Read-only and invariant-free (never throws) — an
  // oversight read over DELIVERED-or-later bills, not the actionable vendor
  // queue, so no BILL_INVARIANT_VIOLATION and no payment/settlement state
  // invention.
  async getFrozenBillBySessionId(
    sessionId: string,
  ): Promise<VendorBillTotalsDTO | null> {
    const rows = (await this.db
      .select()
      .from(session_bills)
      .where(eq(session_bills.session_id, sessionId))) as Record<
      string,
      unknown
    >[];
    const row = rows[0];
    return row ? mapBillTotalsRow(row) : null;
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
