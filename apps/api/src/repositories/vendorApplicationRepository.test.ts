import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryVendorApplicationRepository,
  type CreateVendorApplicationInput,
  type VendorApplicationDTO,
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

// ============================================
// Vendor-application trend timezone (ANALYTICS_TIME_WINDOW-A2).
//
// The trend must bucket by the India business day (fixed IST +05:30, no DST),
// matching admin /metrics, admin /revenue and vendor /insights. The previous
// implementation sliced the UTC date out of the ISO timestamp, so an
// application created/reviewed at/after 18:30 UTC landed on the wrong day.
//
// `computeMetrics` reads the clock via `new Date()` (window anchored on
// "today"), so these tests pin system time with fake timers.
// ============================================

function seedDto(
  repo: MemoryVendorApplicationRepository,
  overrides: Partial<VendorApplicationDTO>,
): VendorApplicationDTO {
  const dto: VendorApplicationDTO = {
    id: "app-0001",
    applicant_id: "applicant-0001",
    name: "Spice Route",
    gst_number: "27ABCDE1234F1Z5",
    fssai_license: "11522000000000",
    phone: "+9100000000",
    contact_email: null,
    address: null,
    city: null,
    lat: null,
    lng: null,
    commission_rate: 0.08,
    status: "PENDING",
    type: "SINGLE",
    outlet_count: 1,
    rejection_reason: null,
    reviewer_id: null,
    reviewed_at: null,
    created_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
  repo._seed(dto);
  return dto;
}

type TrendPoint = { date: string; submitted: number; approved: number; rejected: number };

function pointOn(trend: TrendPoint[], date: string): TrendPoint {
  const found = trend.find((t) => t.date === date);
  if (!found) throw new Error(`no trend bucket for ${date}`);
  return found;
}

describe("MemoryVendorApplicationRepository.getMetrics (IST trend buckets)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("T1: created_at at 18:29 UTC stays on the same IST day; 18:30 UTC advances one day", async () => {
    // 2026-03-12T06:00Z = 11:30 IST; window = last 14 IST days 02-27..03-12.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T06:00:00.000Z"));

    const repo = makeRepo();
    seedDto(repo, {
      id: "app-before",
      created_at: "2026-03-10T18:29:00.000Z", // 23:59 IST 2026-03-10
    });
    seedDto(repo, {
      id: "app-after",
      created_at: "2026-03-10T18:30:00.000Z", // 00:00 IST 2026-03-11
    });

    const metrics = await repo.getMetrics(14);

    expect(pointOn(metrics.trend, "2026-03-10").submitted).toBe(1);
    expect(pointOn(metrics.trend, "2026-03-11").submitted).toBe(1);
    // Under UTC bucketing both would have landed on 2026-03-10.
    expect(pointOn(metrics.trend, "2026-03-10").submitted).not.toBe(2);
  });

  it("T2: reviewed_at buckets into the IST day, not the UTC day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T06:00:00.000Z"));

    const repo = makeRepo();
    seedDto(repo, {
      id: "app-reviewed",
      status: "APPROVED",
      reviewer_id: "admin-1",
      created_at: "2026-03-08T06:00:00.000Z", // IST 2026-03-08
      reviewed_at: "2026-03-09T18:30:00.000Z", // 00:00 IST 2026-03-10
    });

    const metrics = await repo.getMetrics(14);

    expect(pointOn(metrics.trend, "2026-03-10").approved).toBe(1);
    expect(pointOn(metrics.trend, "2026-03-09").approved).toBe(0);
    expect(pointOn(metrics.trend, "2026-03-08").submitted).toBe(1);
  });

  it("T3: ordinary midday timestamps keep their expected IST day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T06:00:00.000Z"));

    const repo = makeRepo();
    seedDto(repo, {
      id: "app-midday-early",
      created_at: "2026-03-09T06:00:00.000Z", // 11:30 IST 2026-03-09
    });
    seedDto(repo, {
      id: "app-midday-late",
      created_at: "2026-03-09T12:00:00.000Z", // 17:30 IST 2026-03-09
    });

    const metrics = await repo.getMetrics(14);

    expect(pointOn(metrics.trend, "2026-03-09").submitted).toBe(2);
  });

  it("T4: status totals and trend window/length are unaffected by IST rebucketing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T06:00:00.000Z"));

    const repo = makeRepo();
    seedDto(repo, { id: "app-p", status: "PENDING", created_at: "2026-03-05T00:00:00.000Z" });
    seedDto(repo, {
      id: "app-a",
      status: "APPROVED",
      reviewer_id: "admin-1",
      created_at: "2026-03-05T00:00:00.000Z",
      reviewed_at: "2026-03-06T12:00:00.000Z",
    });
    seedDto(repo, {
      id: "app-r",
      status: "REJECTED",
      reviewer_id: "admin-2",
      created_at: "2026-03-05T00:00:00.000Z",
      reviewed_at: "2026-03-06T12:00:00.000Z",
    });

    const metrics = await repo.getMetrics(14);

    expect(metrics.total).toBe(3);
    expect(metrics.pending).toBe(1);
    expect(metrics.approved).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.trend).toHaveLength(14);
    // Window is IST-anchored: 14 days ending on the IST "today" (2026-03-12).
    expect(metrics.trend[0]!.date).toBe("2026-02-27");
    expect(metrics.trend[13]!.date).toBe("2026-03-12");
    expect(pointOn(metrics.trend, "2026-03-06").approved).toBe(1);
    expect(pointOn(metrics.trend, "2026-03-06").rejected).toBe(1);
  });
});
