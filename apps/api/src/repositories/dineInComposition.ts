import type { DrizzleDb } from "../lib/dbType";
import { getDb } from "../lib/db";
import { getStorageMode } from "./shared";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
  TableResolveRepository,
} from "./dineInContracts";
import { DrizzleDineInTransactionPort } from "./drizzle/dineInTransactionPort";
import { DrizzleRestaurantTableRepository } from "./drizzle/dineInRepositories";
import {
  buildMemoryDineInRepos,
  MemoryDineInTransactionPort,
  MemoryRestaurantEligibilityReader,
  MemoryRestaurantTableRepository,
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

export function resetDineInState(): void {
  if (!_memoryRepos) return;
  const reset = (repo: unknown): void => {
    (repo as { _reset?: () => void })._reset?.();
  };
  reset(_memoryRepos.restaurantTables);
  reset(_memoryRepos.diningSessions);
  reset(_memoryRepos.staffAssignments);
  reset(_memoryRepos.dineInOrders);
  reset(_memoryRepos.serviceRequests);
  reset(_memoryRepos.sessionBills);
  reset(_memoryRepos.restaurantEligibility);
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
