import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payments } from "@snakzap/db";
import {
  MemoryPaymentRepository,
  RECONCILIATION_CANDIDATE_LIMIT_DEFAULT,
  RECONCILIATION_CANDIDATE_LIMIT_MAX,
  selectReconciliationCandidates,
  type PaymentDTO,
} from "./paymentRepository";

// ============================================
// PAYMENT_RECONCILIATION-A3 durable foundation (memory backend).
//
// Covers F1-F9: migration/schema exposure, real updated_at, additive webhook
// vs reconciliation writes, candidate enumeration and CAS semantics.
// The Drizzle half of the parity contract lives in
// drizzle/drizzlePaymentRepository.test.ts.
// ============================================

const T0 = "2026-01-01T00:00:00.000Z";

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    razorpay_payment_id: "pay_abc",
    status: "CAPTURED" as const,
    method: "upi",
    webhook_event: "payment.captured",
    webhook_raw: { id: "pay_abc", amount: 10000 },
    ...overrides,
  };
}

describe("PAYMENT_RECONCILIATION-A3 durable foundation (memory)", () => {
  let repo: MemoryPaymentRepository;

  beforeEach(() => {
    repo = new MemoryPaymentRepository();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("F1 schema + migration expose the durable reconciliation fields", () => {
    expect(payments.gateway_status.name).toBe("gateway_status");
    expect(payments.reconciliation_status.name).toBe("reconciliation_status");
    expect(payments.reconciliation_reason.name).toBe("reconciliation_reason");
    expect(payments.manual_review.name).toBe("manual_review");
    expect(payments.last_reconciled_at.name).toBe("last_reconciled_at");
    expect(payments.updated_at.name).toBe("updated_at");

    // The change must be captured in a migration SQL file, not just the schema.
    const drizzleDir = path.resolve(__dirname, "../../../../packages/db/drizzle");
    const sql = fs
      .readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => fs.readFileSync(path.join(drizzleDir, name), "utf8"))
      .join("\n");
    for (const column of [
      "gateway_status",
      "reconciliation_status",
      "reconciliation_reason",
      "manual_review",
      "last_reconciled_at",
      "updated_at",
    ]) {
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    }
  });

  it("F2 updated_at is a real column that advances on mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const created = await repo.create({ razorpay_order_id: "order_1", amount: 100 });
    expect(created.updated_at).toBe(T0);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const updated = await repo.updateWebhookResult(created.id, webhook());
    expect(updated!.updated_at).toBe("2026-01-01T00:05:00.000Z");
    expect(updated!.updated_at).not.toBe(created.updated_at);
  });

  it("F3 webhook update preserves reconciliation fields", async () => {
    const created = await repo.create({ razorpay_order_id: "order_2", amount: 100 });
    await repo.markReconciliationResult(created.id, {
      gateway_status: "authorized",
      reconciliation_status: "RETRY",
      reconciliation_reason: "gateway pending",
      manual_review: true,
      last_reconciled_at: "2026-01-01T01:00:00.000Z",
    });

    const after = await repo.updateWebhookResult(created.id, webhook());
    expect(after!.gateway_status).toBe("authorized");
    expect(after!.reconciliation_status).toBe("RETRY");
    expect(after!.reconciliation_reason).toBe("gateway pending");
    expect(after!.manual_review).toBe(true);
    expect(after!.last_reconciled_at).toBe("2026-01-01T01:00:00.000Z");
  });

  it("F4 reconciliation update preserves webhook_raw", async () => {
    const created = await repo.create({ razorpay_order_id: "order_3", amount: 100 });
    await repo.updateWebhookResult(created.id, webhook({ webhook_raw: { id: "pay_3", amount: 10000 } }));

    const after = await repo.markReconciliationResult(created.id, {
      reconciliation_status: "CONVERGED",
      last_reconciled_at: "2026-01-01T02:00:00.000Z",
    });
    expect(after!.webhook_raw).toEqual({ id: "pay_3", amount: 10000 });
    expect(after!.razorpay_payment_id).toBe("pay_abc");
  });

  it("F5 candidate enumeration includes stale CREATED and excludes fresh rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const stale = await repo.create({ razorpay_order_id: "order_stale", amount: 100 });
    vi.setSystemTime(new Date("2026-01-01T03:00:00.000Z"));
    const fresh = await repo.create({ razorpay_order_id: "order_fresh", amount: 100 });

    const candidates = await repo.listReconciliationCandidates({
      staleBefore: "2026-01-01T01:00:00.000Z",
    });
    const ids = candidates.map((p) => p.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it("F6 candidate enumeration includes stale FAILED/REFUNDED and CAPTURED when requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const failed = await repo.create({ razorpay_order_id: "order_failed", amount: 100 });
    await repo.updateWebhookResult(failed.id, webhook({ status: "FAILED" }));
    const captured = await repo.create({ razorpay_order_id: "order_captured", amount: 100 });
    await repo.updateWebhookResult(captured.id, webhook());
    const refunded = await repo.create({ razorpay_order_id: "order_refunded", amount: 100 });
    await repo.updateWebhookResult(refunded.id, webhook({ status: "REFUNDED" }));

    vi.setSystemTime(new Date("2026-01-01T05:00:00.000Z"));
    const staleBefore = "2026-01-01T01:00:00.000Z";

    const withoutCaptured = await repo.listReconciliationCandidates({ staleBefore });
    expect(withoutCaptured.map((p) => p.id)).toEqual(
      expect.arrayContaining([failed.id, refunded.id]),
    );
    expect(withoutCaptured.map((p) => p.id)).not.toContain(captured.id);

    const withCaptured = await repo.listReconciliationCandidates({
      staleBefore,
      includeCaptured: true,
    });
    expect(withCaptured.map((p) => p.id)).toContain(captured.id);
  });

  it("F7 compareAndSetStatus updates when expected matches", async () => {
    const created = await repo.create({ razorpay_order_id: "order_cas", amount: 100 });
    const result = await repo.compareAndSetStatus(created.id, "CREATED", "CAPTURED");
    expect(result.outcome).toBe("UPDATED");
    if (result.outcome !== "UPDATED") throw new Error("unreachable");
    expect(result.payment.status).toBe("CAPTURED");
    expect((await repo.getById(created.id))!.status).toBe("CAPTURED");
  });

  it("F8 compareAndSetStatus is a no-op when expected is stale", async () => {
    const created = await repo.create({ razorpay_order_id: "order_cas2", amount: 100 });
    await repo.compareAndSetStatus(created.id, "CREATED", "CAPTURED");
    const before = await repo.getById(created.id);

    const result = await repo.compareAndSetStatus(created.id, "CREATED", "FAILED");
    expect(result.outcome).toBe("NOOP_STATE_CHANGED");
    const after = await repo.getById(created.id);
    expect(after!.status).toBe("CAPTURED");
    expect(after!.updated_at).toBe(before!.updated_at);
  });

  it("F8b compareAndSetStatus reports NOT_FOUND for a missing row", async () => {
    const result = await repo.compareAndSetStatus(
      "00000000-0000-4000-8000-000000000000",
      "CREATED",
      "CAPTURED",
    );
    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("F5b candidate limit is normalized at the repository boundary (memory parity)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    for (let i = 0; i < 3; i += 1) {
      await repo.create({ razorpay_order_id: `order_limit_${i}`, amount: 100 });
    }
    const staleBefore = "2026-01-01T01:00:00.000Z";

    expect(await repo.listReconciliationCandidates({ staleBefore, limit: 2 })).toHaveLength(2);
    expect(
      await repo.listReconciliationCandidates({ staleBefore, limit: -3 }),
    ).toHaveLength(3);
    expect(
      await repo.listReconciliationCandidates({
        staleBefore,
        limit: 10_000_000,
      }),
    ).toHaveLength(3);
    expect(RECONCILIATION_CANDIDATE_LIMIT_DEFAULT).toBe(100);
    expect(RECONCILIATION_CANDIDATE_LIMIT_MAX).toBe(1000);
  });

  it("F9 repeated reconciliation result is idempotent", async () => {
    const created = await repo.create({ razorpay_order_id: "order_idem", amount: 100 });
    const update = {
      gateway_status: "captured",
      reconciliation_status: "CONVERGED" as const,
      reconciliation_reason: "matched",
      manual_review: false,
      last_reconciled_at: "2026-01-01T06:00:00.000Z",
    };
    const first = await repo.markReconciliationResult(created.id, update);
    const second = await repo.markReconciliationResult(created.id, update);
    for (const field of [
      "gateway_status",
      "reconciliation_status",
      "reconciliation_reason",
      "manual_review",
      "last_reconciled_at",
    ] as const) {
      expect(second![field]).toEqual(first![field]);
    }
  });

  it("F9b selector is shared/pure and stable for parity", () => {
    const dto = (overrides: Partial<PaymentDTO>): PaymentDTO => ({
      id: overrides.id ?? "id",
      order_id: null,
      gift_id: null,
      razorpay_order_id: "order",
      razorpay_payment_id: null,
      amount: 100,
      currency: "INR",
      status: "CREATED",
      method: null,
      webhook_event: null,
      webhook_raw: null,
      gateway_status: null,
      reconciliation_status: "NONE",
      reconciliation_reason: null,
      manual_review: false,
      last_reconciled_at: null,
      created_at: T0,
      updated_at: T0,
      ...overrides,
    });
    const old = dto({ id: "old", created_at: "2026-01-01T00:00:00.000Z" });
    const fresh = dto({ id: "fresh", created_at: "2026-01-01T10:00:00.000Z" });
    const flagged = dto({
      id: "flagged",
      status: "CAPTURED",
      manual_review: true,
      created_at: "2026-01-01T10:00:00.000Z",
    });
    const selected = selectReconciliationCandidates([fresh, old, flagged], {
      staleBefore: "2026-01-01T01:00:00.000Z",
    });
    expect(selected.map((p) => p.id)).toEqual(["old", "flagged"]);
  });
});
