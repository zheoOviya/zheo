import type { DrizzleDb } from "../../lib/dbType";
import { makeTxBoundSessionBill } from "../dineInContracts";
import type {
  DineInTransactionPort,
  DineInTransactionRepos,
} from "../dineInContracts";
import {
  DrizzleDiningSessionRepository,
  DrizzleDineInOrderRepository,
  DrizzleRestaurantEligibilityReader,
  DrizzleRestaurantTableRepository,
  DrizzleServiceRequestRepository,
  DrizzleSessionBillRepository,
  DrizzleStaffAssignmentRepository,
} from "./dineInRepositories";

// ============================================
// Dine-In transaction port (frozen D2.4B/D2.4G).
//
// buildDineInTransactionRepos constructs EVERY tx-scoped repository —
// including sessionBills and restaurantEligibility — from the SAME
// transaction handle. No global/shared repository instance is used.
// ============================================

export function buildDineInTransactionRepos(tx: DrizzleDb): DineInTransactionRepos {
  return {
    restaurantTables: new DrizzleRestaurantTableRepository(tx),
    diningSessions: new DrizzleDiningSessionRepository(tx),
    staffAssignments: new DrizzleStaffAssignmentRepository(tx),
    dineInOrders: new DrizzleDineInOrderRepository(tx),
    serviceRequests: new DrizzleServiceRequestRepository(tx),
    sessionBills: makeTxBoundSessionBill(new DrizzleSessionBillRepository(tx)),
    restaurantEligibility: new DrizzleRestaurantEligibilityReader(tx),
  };
}

export class DrizzleDineInTransactionPort implements DineInTransactionPort {
  constructor(private db: DrizzleDb) {}

  async runInTransaction<T>(
    fn: (repos: DineInTransactionRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildDineInTransactionRepos(tx)));
  }
}
