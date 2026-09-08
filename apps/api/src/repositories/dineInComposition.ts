import type { DrizzleDb } from "../lib/dbType";
import { getDb } from "../lib/db";
import { getStorageMode } from "./shared";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  TableResolveRepository,
  DineInOrderRepository,
  ServiceRequestRepository,
  DineInTableBoardReadRepository,
  DineInBillReadRepository,
  DiningSessionRepository,
} from "./dineInContracts";
import { DrizzleDineInTransactionPort } from "./drizzle/dineInTransactionPort";
import {
  DrizzleRestaurantTableRepository,
  DrizzleDineInOrderRepository,
  DrizzleServiceRequestRepository,
  DrizzleDineInTableBoardRepository,
  DrizzleDineInBillReadRepository,
  DrizzleDiningSessionRepository,
} from "./drizzle/dineInRepositories";
import {
  buildMemoryDineInRepos,
  MemoryDineInTransactionPort,
  MemoryRestaurantEligibilityReader,
  MemoryRestaurantTableRepository,
  MemoryDineInTableBoardRepository,
  MemoryDineInBillReadRepository,
} from "./dineInMemoryRepositories";
import type {
  MemoryDiningSessionRepository,
  MemoryDineInOrderRepository,
  MemoryServiceRequestRepository,
  MemorySessionBillRepository,
} from "./dineInMemoryRepositories";

// ============================================================
// Dine-In runtime composition (H2.1).
//
// One composition surface selects the Dine-In transaction port for the
// configured storage mode, reusing the API's existing storage-mode decision
// (getStorageMode() from repositories/shared.ts — memory for test/preview,
// postgres/drizzle for production). No second dependency-container
// architecture is introduced.
//
//   memory mode  -> MemoryDineInTransactionPort over a single shared
//                   in-memory repo set (contract-complete memory repos)
//   postgres mode-> DrizzleDineInTransactionPort (per-transaction repos
//                   built from the tx handle)
//
// Both DiningSessionService and DineInOrderService receive the SAME port
// instance from getDineInTransactionPort(), so overlapping domains (session,
// order, request, bill) observe the SAME logical repository state.
//
// resetDineInState() clears the in-memory repo set for test isolation
// (no-op in postgres mode). Memory semantics carry no rollback/concurrency
// guarantees — D2.5I owns any real-PG proof.
// ============================================================

export function buildDineInTransactionPort(
  mode: "postgres" | "memory",
  db?: DrizzleDb,
): DineInTransactionPort {
  if (mode === "postgres") {
    return new DrizzleDineInTransactionPort(db ?? getDb());
  }
  return new MemoryDineInTransactionPort(buildMemoryDineInRepos());
}

let _port: DineInTransactionPort | null = null;
let _memoryRepos: DineInTransactionRepos | null = null;

export function getDineInTransactionPort(): DineInTransactionPort {
  if (!_port) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _port = new DrizzleDineInTransactionPort(getDb());
    } else {
      _memoryRepos = buildMemoryDineInRepos();
      _port = new MemoryDineInTransactionPort(_memoryRepos);
    }
  }
  return _port;
}

// Read-only public table resolver (frozen UI1-A-R2/R4). Postgres mode -> the
// Drizzle resolver over the shared db handle (same logical rows as the tx
// port). Memory mode -> the SAME MemoryRestaurantTableRepository instance held
// by the shared memory repo set, so route tests seed one universe. The
// resolve route wires this into DiningSessionService explicitly.
let _tableResolve: TableResolveRepository | null = null;

export function getDineInTableResolveRepository(): TableResolveRepository {
  if (!_tableResolve) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _tableResolve = new DrizzleRestaurantTableRepository(getDb());
    } else {
      getDineInTransactionPort();
      _tableResolve =
        _memoryRepos!.restaurantTables as unknown as TableResolveRepository;
    }
  }
  return _tableResolve;
}

// Read-only vendor Dine-In table/session board surface (DINE-OPS3). Postgres
// mode -> the Drizzle board repository over the shared db handle (bounded
// fixed query set, no N+1). Memory mode -> a MemoryDineInTableBoardRepository
// that reads the SAME shared memory repo instances (tables / sessions /
// orders / requests) held by the shared memory repo set, so route tests seed
// one universe; its memory-only zone registry is exposed via _seedZone and
// cleared by resetDineInState(). Read-only — no mutation surface.
let _vendorTableBoardRepo: DineInTableBoardReadRepository | null = null;

export function getDineInTableBoardReadRepository(): DineInTableBoardReadRepository {
  if (!_vendorTableBoardRepo) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _vendorTableBoardRepo = new DrizzleDineInTableBoardRepository(getDb());
    } else {
      getDineInTransactionPort();
      _vendorTableBoardRepo = new MemoryDineInTableBoardRepository(
        _memoryRepos!.restaurantTables as unknown as MemoryRestaurantTableRepository,
        _memoryRepos!.diningSessions as unknown as MemoryDiningSessionRepository,
        _memoryRepos!.dineInOrders as unknown as MemoryDineInOrderRepository,
        _memoryRepos!.serviceRequests as unknown as MemoryServiceRequestRepository,
      );
    }
  }
  return _vendorTableBoardRepo;
}

export function resetDineInState(): void {
  if (!_memoryRepos) return;
  const reset = (repo: unknown): void => {
    if (repo == null) return;
    (repo as { _reset?: () => void })._reset?.();
  };
  reset(_memoryRepos.restaurantTables);
  reset(_memoryRepos.diningSessions);
  reset(_memoryRepos.staffAssignments);
  reset(_memoryRepos.dineInOrders);
  reset(_memoryRepos.serviceRequests);
  reset(_memoryRepos.sessionBills);
  reset(_memoryRepos.restaurantEligibility);
  reset(_vendorTableBoardRepo);
}

// Deterministic memory-only E2E fixture seam (UI8-A-R1/R2). Returns the SAME
// module-cached memory instances used by GET /tables/resolve
// (getDineInTableResolveRepository) and POST /sessions (the transaction port),
// so a bootstrap fixture can seed the one repository universe the runtime
// routes observe. Memory mode only — the caller owns the fail-closed guards.
// Only the minimum seeding surface is exposed (table + eligibility); no
// session/order/request/bill and no generic repository graph.
export function getDineInE2eSeedRepos(): {
  restaurantTables: MemoryRestaurantTableRepository;
  restaurantEligibility: MemoryRestaurantEligibilityReader;
} {
  getDineInTransactionPort();
  return {
    restaurantTables:
      _memoryRepos!.restaurantTables as unknown as MemoryRestaurantTableRepository,
    restaurantEligibility:
      _memoryRepos!.restaurantEligibility as unknown as MemoryRestaurantEligibilityReader,
  };
}

// Read-only vendor Dine-In order surface (DINE-OPS1.2). Postgres mode -> the
// Drizzle order repository over the shared db handle (same logical rows as the
// tx port). Memory mode -> the SAME MemoryDineInOrderRepository held by the
// shared memory repo set, so route tests seed one universe. The vendor
// kitchen-queue route wires this directly; the returned repository exposes
// only read methods (no writes).
let _vendorOrderReadRepo: DineInOrderRepository | null = null;

export function getDineInOrderReadRepository(): DineInOrderRepository {
  if (!_vendorOrderReadRepo) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _vendorOrderReadRepo = new DrizzleDineInOrderRepository(getDb());
    } else {
      getDineInTransactionPort();
      _vendorOrderReadRepo =
        _memoryRepos!.dineInOrders as unknown as DineInOrderRepository;
    }
  }
  return _vendorOrderReadRepo;
}

// Read-only vendor Dine-In service-request surface (DINE-OPS2). Postgres mode
// -> the Drizzle service-request repository over the shared db handle (same
// logical rows as the tx port). Memory mode -> the SAME
// MemoryServiceRequestRepository held by the shared memory repo set, so route
// tests seed one universe. Only read methods are invoked through the returned
// repository surface (getById / operations queue).
let _vendorServiceRequestReadRepo: ServiceRequestRepository | null = null;

export function getDineInServiceRequestReadRepository(): ServiceRequestRepository {
  if (!_vendorServiceRequestReadRepo) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _vendorServiceRequestReadRepo = new DrizzleServiceRequestRepository(getDb());
    } else {
      getDineInTransactionPort();
      _vendorServiceRequestReadRepo =
        _memoryRepos!.serviceRequests as unknown as ServiceRequestRepository;
    }
  }
  return _vendorServiceRequestReadRepo;
}

// Read-only vendor Dine-In bill surface (DINE-OPS4-B1). Postgres mode -> the
// Drizzle bill read repository over the shared db handle (bounded fixed query
// set, no N+1). Memory mode -> a MemoryDineInBillReadRepository that reads the
// SAME shared memory repo instances (tables / sessions / orders / requests /
// bills) held by the shared memory repo set AND the SAME table-board zone
// registry, so route tests seed one universe. Read-only — no mutation surface.
let _vendorBillReadRepo: DineInBillReadRepository | null = null;

export function getDineInBillReadRepository(): DineInBillReadRepository {
  if (!_vendorBillReadRepo) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _vendorBillReadRepo = new DrizzleDineInBillReadRepository(getDb());
    } else {
      getDineInTransactionPort();
      getDineInTableBoardReadRepository();
      _vendorBillReadRepo = new MemoryDineInBillReadRepository(
        _memoryRepos!.restaurantTables as unknown as MemoryRestaurantTableRepository,
        _memoryRepos!.diningSessions as unknown as MemoryDiningSessionRepository,
        _memoryRepos!.dineInOrders as unknown as MemoryDineInOrderRepository,
        _memoryRepos!.serviceRequests as unknown as MemoryServiceRequestRepository,
        _memoryRepos!.sessionBills as unknown as MemorySessionBillRepository,
        _vendorTableBoardRepo as unknown as MemoryDineInTableBoardRepository,
      );
    }
  }
  return _vendorBillReadRepo;
}

// Read-only non-transactional Dine-In session surface (ADMIN-OPS1-A2). The
// admin read service needs per-session identity + live-state reads OUTSIDE any
// transaction — the session repos on the tx port are transaction-scoped and
// the table-board rows carry only {id,status,opened_at,bill_requested_at}, so
// this is the dedicated accessor for overview/list/detail composition. Postgres
// mode -> the Drizzle session repository over the shared db handle (single-row
// selects, bounded). Memory mode -> the SAME MemoryDiningSessionRepository held
// by the shared memory repo set, so admin route tests seed one universe and
// resetDineInState() clears it. Only the getById read is invoked through the
// returned surface.
let _adminSessionReadRepo: DiningSessionRepository | null = null;

export function getDineInSessionReadRepository(): DiningSessionRepository {
  if (!_adminSessionReadRepo) {
    const mode = getStorageMode();
    if (mode === "postgres") {
      _adminSessionReadRepo = new DrizzleDiningSessionRepository(getDb());
    } else {
      getDineInTransactionPort();
      _adminSessionReadRepo =
        _memoryRepos!.diningSessions as unknown as DiningSessionRepository;
    }
  }
  return _adminSessionReadRepo;
}
