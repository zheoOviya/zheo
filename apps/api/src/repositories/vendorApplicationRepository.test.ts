import { describe, expect, it, vi } from "vitest";
import {
  MemoryVendorApplicationRepository,
  type CreateVendorApplicationInput,
} from "./vendorApplicationRepository";

// ============================================
// Vendor application CAS semantics (VENDOR-APPROVAL-ATOMICITY-A2).
//
// Memory proves API semantics only — NOT concurrency or rollback. Real
// atomicity is Postgres-only and proven by the real-PG harness.
// ============================================

function makeRepo(): MemoryVendorApplicationRepository {
  return new MemoryVendorApplicationRepository();
}

async function seedApp(
  repo: MemoryVendorApplicationRepository,
  overrides: Partial<CreateVendorApplicationInput> = {},
) {
  return repo.create({
    applicant_id: "applicant-0001",
    name: "Spice Route",
    gst_number: "27ABCDE1234F1Z5",
    fssai_license: "11522000000000",
    phone: "+9100000000",
    ...overrides,
  });
}

describe("MemoryVendorApplicationRepository.transitionStatus", () => {
  it("R1: PENDING -> APPROVED succeeds", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    const updated = await repo.transitionStatus(app.id, "PENDING", "APPROVED", "admin-1");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("APPROVED");
    expect(updated!.reviewer_id).toBe("admin-1");
    expect(updated!.reviewed_at).not.toBeNull();
    expect(updated!.rejection_reason).toBeNull();
  });

  it("R2: second PENDING -> APPROVED returns null", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    await repo.transitionStatus(app.id, "PENDING", "APPROVED", "admin-1");
    const second = await repo.transitionStatus(app.id, "PENDING", "APPROVED", "admin-2");
    expect(second).toBeNull();
  });

  it("R3: PENDING -> REJECTED succeeds with reason", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    const updated = await repo.transitionStatus(
      app.id,
      "PENDING",
      "REJECTED",
      "admin-1",
      "GST number could not be verified",
    );
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("REJECTED");
    expect(updated!.rejection_reason).toBe("GST number could not be verified");
    expect(updated!.reviewer_id).toBe("admin-1");
  });

  it("R4: missing id returns null", async () => {
    const repo = makeRepo();
    const updated = await repo.transitionStatus(
      "00000000-0000-4000-8000-000000000000",
      "PENDING",
      "APPROVED",
      "admin-1",
    );
    expect(updated).toBeNull();
  });

  it("R5: wrong fromStatus returns null and leaves status unchanged", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    const updated = await repo.transitionStatus(app.id, "APPROVED", "REJECTED", "admin-1");
    expect(updated).toBeNull();
    const current = await repo.getById(app.id);
    expect(current!.status).toBe("PENDING");
  });

  it("R6: reviewer/reviewed_at/rejection fields preserved and other fields unchanged", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo, { name: "Curry House", applicant_id: "applicant-9" });
    const rejected = await repo.transitionStatus(app.id, "PENDING", "REJECTED", "admin-7", "bad docs");
    expect(rejected!.reviewer_id).toBe("admin-7");
    expect(rejected!.rejection_reason).toBe("bad docs");
    expect(Number.isNaN(Date.parse(rejected!.reviewed_at!))).toBe(false);
    expect(rejected!.name).toBe("Curry House");
    expect(rejected!.applicant_id).toBe("applicant-9");
    expect(rejected!.created_at).toBe(app.created_at);
  });

  it("R7: APPROVED transition clears rejectionReason", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    const rejected = await repo.transitionStatus(app.id, "PENDING", "REJECTED", "admin-1", "nope");
    expect(rejected!.rejection_reason).toBe("nope");
    const approved = await repo.transitionStatus(app.id, "REJECTED", "APPROVED", "admin-2");
    expect(approved!.status).toBe("APPROVED");
    expect(approved!.rejection_reason).toBeNull();
  });

  it("R8: success path returns the updated DTO without a blind reread", async () => {
    const repo = makeRepo();
    const app = await seedApp(repo);
    const getByIdSpy = vi.spyOn(repo, "getById");
    const updated = await repo.transitionStatus(app.id, "PENDING", "APPROVED", "admin-1");
    expect(updated!.status).toBe("APPROVED");
    expect(getByIdSpy).not.toHaveBeenCalled();
  });
});
