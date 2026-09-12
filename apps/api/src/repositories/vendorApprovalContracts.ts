import type {
  VendorApplicationDTO,
  VendorApplicationStatus,
} from "./vendorApplicationRepository";
import type { CreateRestaurantInput, RestaurantDTO } from "./catalogRepository";
import type { ChainDTO } from "./chainRepository";
import type { IdentityUser } from "./identityRepository";
import type { AssignUserRoleInput, UserRoleDTO } from "./userRoleRepository";
import type { AuditLogEntry } from "./auditRepository";

// ============================================
// Vendor-approval transaction contracts (VENDOR-APPROVAL-ATOMICITY-A2).
//
// Narrow structural interfaces describing only what the approve/reject
// orchestration needs, so the transaction cannot reach unrelated repository
// APIs. Concrete Drizzle repositories satisfy these structurally once bound
// to the same transaction handle.
// ============================================

export interface VendorApprovalApplicationRepo {
  /** Atomic claim + status transition; null on missing row or mismatch. */
  transitionStatus(
    id: string,
    fromStatus: VendorApplicationStatus,
    toStatus: VendorApplicationStatus,
    reviewerId: string,
    rejectionReason?: string | null,
  ): Promise<VendorApplicationDTO | null>;
  getById(id: string): Promise<VendorApplicationDTO | null>;
}

export interface VendorApprovalCatalogRepo {
  createRestaurant(input: CreateRestaurantInput): Promise<RestaurantDTO>;
}

export interface VendorApprovalChainRepo {
  create(name: string, ownerId: string): Promise<ChainDTO>;
}

export interface VendorApprovalIdentityRepo {
  updateRole(userId: string, role: IdentityUser["role"]): Promise<IdentityUser | null>;
}

export interface VendorApprovalUserRoleRepo {
  assign(input: AssignUserRoleInput): Promise<UserRoleDTO>;
}

export interface VendorApprovalAuditRepo {
  log(
    actorId: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<AuditLogEntry>;
}

export interface VendorApprovalTxRepos {
  vendorApplication: VendorApprovalApplicationRepo;
  catalog: VendorApprovalCatalogRepo;
  chain: VendorApprovalChainRepo;
  identity: VendorApprovalIdentityRepo;
  userRole: VendorApprovalUserRoleRepo;
  audit: VendorApprovalAuditRepo;
}

export interface VendorApprovalTransactionPort {
  runInTransaction<T>(fn: (repos: VendorApprovalTxRepos) => Promise<T>): Promise<T>;
}

/** Resolves the memory-backed repositories for the approval transaction. */
export type VendorApprovalTxRepoProvider = () => VendorApprovalTxRepos;

/**
 * Memory/test transaction port.
 *
 * MEMORY_ATOMICITY_GUARANTEE = NONE.
 *
 * This is an explicit PASSTHROUGH execution model: the callback receives the
 * existing memory-backed repositories, with no snapshotting, no locking, no
 * rollback and no concurrency guarantee. A throwing callback may leave partial
 * mutations in place. It exists only so route/unit tests can exercise the
 * approve/reject control flow and CAS semantics; real atomicity is Postgres-only
 * and proven by the real-PG harness.
 *
 * The provider is resolved at call time so the port always observes the
 * current route-visible stores (no stale instances across test resets).
 */
export class MemoryVendorApprovalTransactionPort
  implements VendorApprovalTransactionPort
{
  constructor(private readonly provider: VendorApprovalTxRepoProvider) {}

  async runInTransaction<T>(
    fn: (repos: VendorApprovalTxRepos) => Promise<T>,
  ): Promise<T> {
    return fn(this.provider());
  }
}
