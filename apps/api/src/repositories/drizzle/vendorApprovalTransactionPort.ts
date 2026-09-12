import type { DrizzleDb } from "../../lib/dbType";
import { getDb } from "../../lib/db";
import {
  MemoryVendorApprovalTransactionPort,
  type VendorApprovalTransactionPort,
  type VendorApprovalTxRepos,
} from "../vendorApprovalContracts";
import {
  getStorageMode,
  sharedAuditRepo,
  sharedChainRepo,
  sharedIdentityRepo,
  sharedUserRoleRepo,
  sharedVendorApplicationRepo,
} from "../shared";
import { getCatalogRepository } from "../../routes/catalog";
import { DrizzleVendorApplicationRepository } from "../vendorApplicationRepository";
import { DrizzleCatalogRepository } from "../catalogRepository";
import { DrizzleChainRepository } from "../chainRepository";
import { DrizzleUserRoleRepository } from "../userRoleRepository";
import { DrizzleIdentityRepository } from "./drizzleIdentityRepository";
import { DrizzleAuditRepository } from "./drizzleAuditRepository";

// ============================================
// Drizzle vendor-approval transaction port (VENDOR-APPROVAL-ATOMICITY-A2).
//
// buildVendorApprovalTxRepos constructs EVERY tx-scoped repository from the
// SAME transaction handle so application claim, chain/restaurant creation,
// role mutations, status transition and the audit row share one commit
// boundary. No global/shared repository instance is used.
// ============================================

export function buildVendorApprovalTxRepos(tx: DrizzleDb): VendorApprovalTxRepos {
  return {
    vendorApplication: new DrizzleVendorApplicationRepository(tx),
    catalog: new DrizzleCatalogRepository(tx),
    chain: new DrizzleChainRepository(tx),
    identity: new DrizzleIdentityRepository(tx),
    userRole: new DrizzleUserRoleRepository(tx),
    audit: new DrizzleAuditRepository(tx),
  };
}

export class DrizzleVendorApprovalTransactionPort
  implements VendorApprovalTransactionPort
{
  constructor(private readonly db: DrizzleDb) {}

  runInTransaction<T>(
    fn: (repos: VendorApprovalTxRepos) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(buildVendorApprovalTxRepos(tx)));
  }
}

/** Factory for the Postgres-backed approval transaction port. */
export function createVendorApprovalTransactionPort(
  db: DrizzleDb,
): VendorApprovalTransactionPort {
  return new DrizzleVendorApprovalTransactionPort(db);
}

// ============================================
// Runtime composition (storage-mode aware).
//
//   postgres -> DrizzleVendorApprovalTransactionPort (per-transaction repos
//               built from the tx handle; real atomicity)
//   memory   -> MemoryVendorApprovalTransactionPort (PASSTHROUGH over the
//               route-visible memory repos; no rollback/concurrency claim)
//
// getDb() is only reachable on the explicit postgres branch, so memory/test
// mode never constructs a Postgres client or falls back from a Postgres
// failure. The memory bundle is resolved from existing getters at call time,
// so the transaction observes the same logical stores as the routes and no
// stale instances survive a test reset.
// ============================================

function memoryVendorApprovalTxRepos(): VendorApprovalTxRepos {
  return {
    vendorApplication: sharedVendorApplicationRepo,
    catalog: getCatalogRepository(),
    chain: sharedChainRepo,
    identity: sharedIdentityRepo,
    userRole: sharedUserRoleRepo,
    audit: sharedAuditRepo,
  };
}

let _port: VendorApprovalTransactionPort | null = null;

export function getVendorApprovalTransactionPort(): VendorApprovalTransactionPort {
  if (_port) return _port;
  if (getStorageMode() === "postgres") {
    _port = new DrizzleVendorApprovalTransactionPort(getDb());
  } else {
    _port = new MemoryVendorApprovalTransactionPort(memoryVendorApprovalTxRepos);
  }
  return _port;
}
