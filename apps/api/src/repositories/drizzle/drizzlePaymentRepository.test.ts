import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payments } from "@snakzap/db";
import type { DrizzleDb } from "../../lib/dbType";
import {
  MemoryPaymentRepository,
  RECONCILIATION_CANDIDATE_LIMIT_DEFAULT,
  RECONCILIATION_CANDIDATE_LIMIT_MAX,
  type PaymentDTO,
  type PaymentRepository,
} from "../paymentRepository";
import { DrizzlePaymentRepository } from "./drizzlePaymentRepository";

// ============================================
// PAYMENT_RECONCILIATION-A3 durable foundation (Drizzle backend + parity).
// Extended by PAYMENT_RECONCILIATION-A3R (Gate 63158): DB-side candidate
// query bounding.
//
// Runs the REAL DrizzlePaymentRepository code path against an in-memory
// DrizzleDb stand-in that (a) evaluates the drizzle-orm SQL AST produced by
// the repository and (b) spies on the generated query chain. It supports
// select/insert/update incl. .returning(), eq()/and()/or()/inArray()/lte()
// and orderBy()/limit(). No live Postgres needed here; real-Postgres
// durability is proven separately by the integration harness.
//
// Discriminating assertions:
//   - updateWebhookResult must MERGE metadata (old code replaced the blob).
//   - mapPaymentRow must surface a real updated_at (old code reused created_at).
//   - Q1-Q11: candidate enumeration must filter/order/limit in the DB query,
//     never materialize the whole payments table.
//   - F10: Memory and Drizzle produce identical candidate sets.
// ============================================

// ---------- drizzle AST helpers ----------

function isStringChunk(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === "object" &&
    (chunk as { constructor?: { name?: string } }).constructor?.name === "StringChunk"
  );
}

function isParam(chunk: unknown): boolean {
  return !!chunk && typeof chunk === "object" && (chunk as { encoder?: unknown }).encoder !== undefined;
}

function isColumn(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === "object" &&
    !isStringChunk(chunk) &&
    !Array.isArray(chunk) &&
    !(chunk as { queryChunks?: unknown }).queryChunks &&
    typeof (chunk as { name?: unknown }).name === "string"
  );
}

const COMPARISON_OPS = new Set(["=", "<=", "<", ">=", ">", "in", "<>", "!=", "like"]);

/** Evaluates the subset of the drizzle SQL AST the repository emits. */
function evalCond(node: unknown, row: Record<string, unknown>): boolean {
  if (node == null) return true;
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(queryChunks)) return true;

  const stringParts = queryChunks
    .filter(isStringChunk)
    .map((chunk) => String((chunk as { value: unknown[] }).value[0]).trim());
  const operands = queryChunks.filter((chunk) => !isStringChunk(chunk));

  if (stringParts.includes("or")) return operands.some((op) => evalCond(op, row));
  if (stringParts.includes("and")) return operands.every((op) => evalCond(op, row));

  if (stringParts.includes("is not null")) {
    const column = operands.find(isColumn) as { name: string } | undefined;
    if (!column) return true;
    const value = row[column.name];
    return value !== null && value !== undefined;
  }
  if (stringParts.includes("is null")) {
    const column = operands.find(isColumn) as { name: string } | undefined;
    if (!column) return true;
    const value = row[column.name];
    return value === null || value === undefined;
  }

  const op = stringParts.find((part) => COMPARISON_OPS.has(part));
  if (!op) {
    const nested = operands.filter(
      (op) => !!op && typeof op === "object" && (op as { queryChunks?: unknown }).queryChunks,
    );
    if (nested.length === 1) return evalCond(nested[0], row);
    return nested.every((op) => evalCond(op, row));
  }

  const column = operands.find(isColumn) as { name: string } | undefined;
  if (!column) return true;
  const left = row[column.name];

  if (op === "in") {
    const list = (operands.find(Array.isArray) as unknown[] | undefined) ?? [];
    return list.map((param) => (param as { value: unknown }).value).includes(left);
  }

  const param = operands.find(isParam) as { value: unknown } | undefined;
  const secondColumn = operands.filter(isColumn)[1] as { name: string } | undefined;
  const right = param ? param.value : secondColumn ? row[secondColumn.name] : undefined;

  switch (op) {
    case "=":
      return left === right;
    case "<=":
      return (left as number) <= (right as number);
    case "<":
      return (left as number) < (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case ">":
      return (left as number) > (right as number);
    case "<>":
    case "!=":
      return left !== right;
    default:
      return true;
  }
}

/** Renders an AST back to a short SQL-ish string for Q11 assertions. */
function sqlText(node: unknown): string {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(sqlText).join(",");
  if (isStringChunk(node)) return String((node as { value: unknown[] }).value[0]);
  if (isParam(node)) return "?";
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) return queryChunks.map(sqlText).join("");
  if (typeof (node as { name?: unknown }).name === "string") return (node as { name: string }).name;
  return "";
}

function extractOrder(expr: unknown): { col?: string; direction: "asc" | "desc" } {
  let col: string | undefined;
  let direction: "asc" | "desc" = "asc";
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const queryChunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(queryChunks)) return;
    for (const chunk of queryChunks) {
      if (typeof (chunk as { name?: unknown }).name === "string" && col === undefined) {
        col = (chunk as { name: string }).name;
      }
      if (isStringChunk(chunk) && String((chunk as { value: unknown[] }).value[0]).trim() === "desc") {
        direction = "desc";
      }
      walk(chunk);
    }
  };
  walk(expr);
  return { col, direction };
}

// ---------- FakeDb ----------

interface QuerySpy {
  whereCalls: unknown[];
  orderByCalls: Array<{ col?: string; direction: "asc" | "desc" }>;
  limitCalls: number[];
}

interface FakeDb {
  db: DrizzleDb;
  rowsFor: (table: unknown) => Record<string, unknown>[];
  spy: QuerySpy;
}

function createFakeDb(): FakeDb {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };
  const spy: QuerySpy = { whereCalls: [], orderByCalls: [], limitCalls: [] };

  const predicateFrom = (cond: unknown): ((row: Record<string, unknown>) => boolean) => {
    if (cond == null) return () => true;
    // Reuse the full AST evaluator so update/delete WHERE clauses (including
    // `IS NULL` guards used by the refund reservation CAS) are enforced the
    // same way a real database would — no pre-read shortcut.
    return (row) => evalCond(cond, row);
  };

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond?: unknown) => {
          spy.whereCalls.push(cond);
          const state: {
            cond?: unknown;
            orderCol?: string;
            orderDirection?: "asc" | "desc";
            limitN?: number;
          } = { cond };
          const evaluate = (): Record<string, unknown>[] => {
            let rows = rowsFor(table).filter((row) => evalCond(state.cond, row));
            if (state.orderCol) {
              const col = state.orderCol;
              rows = [...rows].sort((a, b) => {
                const av = a[col];
                const bv = b[col];
                const cmp =
                  av instanceof Date && bv instanceof Date
                    ? av.getTime() - bv.getTime()
                    : String(av).localeCompare(String(bv));
                return state.orderDirection === "desc" ? -cmp : cmp;
              });
            }
            if (state.limitN !== undefined) rows = rows.slice(0, state.limitN);
            return rows;
          };
          const chain = {
            orderBy: (expr: unknown) => {
              const { col, direction } = extractOrder(expr);
              state.orderCol = col;
              state.orderDirection = direction;
              spy.orderByCalls.push({ col, direction });
              return {
                limit: async (n: number) => {
                  state.limitN = n;
                  spy.limitCalls.push(n);
                  return evaluate();
                },
              };
            },
            limit: async (n: number) => {
              state.limitN = n;
              spy.limitCalls.push(n);
              return evaluate();
            },
            then: (
              resolve: (rows: Record<string, unknown>[]) => unknown,
              reject?: (err: unknown) => unknown,
            ) => Promise.resolve(evaluate()).then(resolve, reject),
          };
          return chain;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        const row = { created_at: new Date(), ...values };
        rowsFor(table).push(row);
        return [row];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond?: unknown) => {
          const pred = predicateFrom(cond);
          let applied: Record<string, unknown>[] | null = null;
          const run = (): Record<string, unknown>[] => {
            if (applied) return applied;
            const matched = rowsFor(table).filter(pred);
            matched.forEach((r) => Object.assign(r, values));
            applied = matched;
            return applied;
          };
          return {
            then: (
              resolve: (rows: Record<string, unknown>[]) => unknown,
              reject?: (err: unknown) => unknown,
            ) => Promise.resolve(run()).then(resolve, reject),
            returning: () => Promise.resolve(run()),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond?: unknown) => {
        const pred = predicateFrom(cond);
        const matched = rowsFor(table).filter(pred);
        tables.set(table, rowsFor(table).filter((r) => !pred(r)));
        return matched;
      },
    }),
    transaction: async <T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> =>
      fn(db as unknown as DrizzleDb),
  };

  return { db: db as unknown as DrizzleDb, rowsFor, spy };
}

const WEBHOOK = {
  razorpay_payment_id: "pay_dz",
  status: "CAPTURED" as const,
  method: "upi",
  webhook_event: "payment.captured",
  webhook_raw: { id: "pay_dz", amount: 25050 },
};

let rowSeq = 0;
function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  rowSeq += 1;
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `00000000-0000-4000-8000-0000000000${String(rowSeq).padStart(2, "0")}`,
    order_id: `10000000-0000-4000-8000-0000000000${String(rowSeq).padStart(2, "0")}`,
    gift_id: null,
    provider: "razorpay",
    provider_transaction_id: `order_${rowSeq}`,
    amount: "100.00",
    status: "CREATED",
    metadata: { currency: "INR" },
    gateway_status: null,
    reconciliation_status: "NONE",
    reconciliation_reason: null,
    manual_review: false,
    last_reconciled_at: null,
    refund_requested_at: null,
    refund_provider_id: null,
    refund_initiation_status: "NONE",
    refund_initiation_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function snapshot(dto: PaymentDTO | null): Record<string, unknown> | null {
  if (!dto) return null;
  const { id: _id, ...rest } = dto;
  return rest;
}

const STALE_BEFORE = "2026-01-01T01:00:00.000Z";

describe("PAYMENT_RECONCILIATION-A3/A3R (drizzle)", () => {
  let fake: FakeDb;
  let repo: DrizzlePaymentRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzlePaymentRepository(fake.db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("D1 updateWebhookResult merges metadata (currency/webhook_raw survive) and never touches reconciliation columns", async () => {
    const created = await repo.create({ razorpay_order_id: "order_d1", amount: 250.5 });
    await repo.markReconciliationResult(created.id, {
      gateway_status: "authorized",
      reconciliation_status: "RETRY",
      reconciliation_reason: "pending",
      manual_review: true,
      last_reconciled_at: "2026-01-01T01:00:00.000Z",
    });

    const after = await repo.updateWebhookResult(created.id, WEBHOOK);
    expect(after!.currency).toBe("INR");
    expect(after!.webhook_raw).toEqual({ id: "pay_dz", amount: 25050 });
    expect(after!.manual_review).toBe(true);
    expect(after!.reconciliation_status).toBe("RETRY");
    expect(after!.reconciliation_reason).toBe("pending");
    expect(after!.gateway_status).toBe("authorized");

    const rawMeta = fake.rowsFor(payments)[0]!.metadata as Record<string, unknown>;
    expect(rawMeta.currency).toBe("INR");
    expect(rawMeta.webhook_raw).toEqual({ id: "pay_dz", amount: 25050 });
  });

  it("D2 mapPaymentRow surfaces a real updated_at (not created_at)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const created = await repo.create({ razorpay_order_id: "order_d2", amount: 100 });
    expect(created.updated_at).toBe("2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    await repo.updateWebhookResult(created.id, WEBHOOK);
    const reloaded = await repo.getById(created.id);
    expect(reloaded!.updated_at).toBe("2026-01-01T00:05:00.000Z");
    expect(reloaded!.updated_at).not.toBe(reloaded!.created_at);
  });

  it("D3 compareAndSetStatus uses the DB status predicate and no-ops on mismatch", async () => {
    const created = await repo.create({ razorpay_order_id: "order_d3", amount: 100 });

    const ok = await repo.compareAndSetStatus(created.id, "CREATED", "CAPTURED");
    expect(ok.outcome).toBe("UPDATED");
    expect(fake.rowsFor(payments)[0]!.status).toBe("CAPTURED");

    const stale = await repo.compareAndSetStatus(created.id, "CREATED", "FAILED");
    expect(stale.outcome).toBe("NOOP_STATE_CHANGED");
    expect(fake.rowsFor(payments)[0]!.status).toBe("CAPTURED");
  });

  it("D4 missing row CAS reports NOT_FOUND", async () => {
    const result = await repo.compareAndSetStatus(
      "00000000-0000-4000-8000-000000000000",
      "CREATED",
      "CAPTURED",
    );
    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("Q1-Q4 candidate enumeration includes stale CREATED/FAILED/REFUNDED and excludes fresh CREATED", async () => {
    fake.rowsFor(payments).push(
      paymentRow({ status: "CREATED", created_at: new Date("2026-01-01T00:00:00.000Z") }),
      paymentRow({ status: "FAILED", created_at: new Date("2026-01-01T00:00:00.000Z") }),
      paymentRow({ status: "REFUNDED", created_at: new Date("2026-01-01T00:00:00.000Z") }),
      paymentRow({ status: "CREATED", created_at: new Date("2026-01-01T05:00:00.000Z") }),
    );
    const ids = (await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE })).map(
      (p) => p.status,
    );
    expect(ids).toEqual(["CREATED", "FAILED", "REFUNDED"]);
  });

  it("Q5/Q6 CAPTURED is excluded by default and included when includeCaptured=true", async () => {
    fake.rowsFor(payments).push(
      paymentRow({ status: "CAPTURED", created_at: new Date("2026-01-01T00:00:00.000Z") }),
    );
    const excluded = await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE });
    expect(excluded).toHaveLength(0);

    const included = await repo.listReconciliationCandidates({
      staleBefore: STALE_BEFORE,
      includeCaptured: true,
    });
    expect(included.map((p) => p.status)).toEqual(["CAPTURED"]);
  });

  it("Q7 manual_review row is always included even when fresh and not otherwise eligible", async () => {
    fake.rowsFor(payments).push(
      paymentRow({
        status: "CAPTURED",
        manual_review: true,
        created_at: new Date("2026-01-01T09:00:00.000Z"),
      }),
    );
    const rows = await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE });
    expect(rows.map((p) => p.manual_review)).toEqual([true]);
  });

  it("Q8 reconciliation_status=MANUAL_REVIEW row is always included", async () => {
    fake.rowsFor(payments).push(
      paymentRow({
        status: "CAPTURED",
        reconciliation_status: "MANUAL_REVIEW",
        created_at: new Date("2026-01-01T09:00:00.000Z"),
      }),
    );
    const rows = await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE });
    expect(rows.map((p) => p.reconciliation_status)).toEqual(["MANUAL_REVIEW"]);
  });

  it("Q9 candidates are ordered oldest-first", async () => {
    fake.rowsFor(payments).push(
      paymentRow({ provider_transaction_id: "order_newest", created_at: new Date("2026-01-01T00:30:00.000Z") }),
      paymentRow({ provider_transaction_id: "order_oldest", created_at: new Date("2026-01-01T00:00:00.000Z") }),
      paymentRow({ provider_transaction_id: "order_middle", created_at: new Date("2026-01-01T00:15:00.000Z") }),
    );
    const orders = (await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE })).map(
      (p) => p.razorpay_order_id,
    );
    expect(orders).toEqual(["order_oldest", "order_middle", "order_newest"]);
  });

  it("Q10 limit is normalized and enforced at the DB query boundary", async () => {
    fake.rowsFor(payments).push(
      paymentRow({ created_at: new Date("2026-01-01T00:00:00.000Z") }),
      paymentRow({ created_at: new Date("2026-01-01T00:10:00.000Z") }),
      paymentRow({ created_at: new Date("2026-01-01T00:20:00.000Z") }),
    );

    const limited = await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(fake.spy.limitCalls.at(-1)).toBe(2);

    await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE, limit: -5 });
    expect(fake.spy.limitCalls.at(-1)).toBe(RECONCILIATION_CANDIDATE_LIMIT_DEFAULT);

    await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE, limit: 10_000_000 });
    expect(fake.spy.limitCalls.at(-1)).toBe(RECONCILIATION_CANDIDATE_LIMIT_MAX);
  });

  it("Q11 query is bounded (no select-all): predicate, ORDER BY and LIMIT are all present", async () => {
    fake.rowsFor(payments).push(paymentRow({ created_at: new Date("2026-01-01T00:00:00.000Z") }));
    fake.spy.whereCalls.length = 0;
    fake.spy.orderByCalls.length = 0;
    fake.spy.limitCalls.length = 0;

    await repo.listReconciliationCandidates({ staleBefore: STALE_BEFORE, includeCaptured: true });

    expect(fake.spy.whereCalls).toHaveLength(1);
    expect(fake.spy.orderByCalls).toEqual([{ col: "created_at", direction: "asc" }]);
    expect(fake.spy.limitCalls).toHaveLength(1);

    const where = sqlText(fake.spy.whereCalls[0]);
    expect(where).toContain("manual_review");
    expect(where).toContain("reconciliation_status");
    expect(where).toContain("status");
    expect(where).toContain(" in ");
    expect(where).toContain("created_at");
    expect(where).toContain(" or ");
    expect(where).toContain(" and ");
  });

  it("F10 Memory and Drizzle produce identical candidate sets and DTOs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    async function run(target: PaymentRepository): Promise<Record<string, unknown> | null> {
      const created = await target.create({
        razorpay_order_id: "order_parity",
        amount: 250.5,
        currency: "INR",
      });
      await target.updateWebhookResult(created.id, WEBHOOK);
      await target.markReconciliationResult(created.id, {
        gateway_status: "captured",
        reconciliation_status: "CONVERGED",
        reconciliation_reason: "matched",
        manual_review: false,
        last_reconciled_at: "2026-01-01T02:00:00.000Z",
      });
      await target.compareAndSetStatus(created.id, "CAPTURED", "CAPTURED");
      return snapshot(await target.getById(created.id));
    }

    const memoryRepo = new MemoryPaymentRepository();
    const memory = await run(memoryRepo);
    const drizzle = await run(repo);
    expect(drizzle).toEqual(memory);

    const q = { staleBefore: "2026-01-01T03:00:00.000Z", includeCaptured: true };
    const memCandidates = (await memoryRepo.listReconciliationCandidates(q)).map(snapshot);
    const dzCandidates = (await repo.listReconciliationCandidates(q)).map(snapshot);
    expect(dzCandidates).toEqual(memCandidates);
  });
});

// ============================================
// PAYMENT_CANCEL_REFUND-A1 refund-initiation foundation (Drizzle + parity).
//
// The reservation CAS must be enforced by the DB predicate (id AND status AND
// refund_requested_at IS NULL), not by a pre-read alone. The FakeDb evaluates
// the real drizzle-orm SQL AST, so the IS NULL guard is exercised end to end.
// ============================================

describe("PAYMENT_CANCEL_REFUND-A1 refund reservation foundation (drizzle)", () => {
  let fake: FakeDb;
  let repo: DrizzlePaymentRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzlePaymentRepository(fake.db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function capturedRow(): Record<string, unknown> {
    const row = paymentRow({ status: "CAPTURED" });
    fake.rowsFor(payments).push(row);
    return row;
  }

  it("D-RF3 a CAPTURED unreserved row can be reserved and persists RESERVED", async () => {
    const row = capturedRow();
    const result = await repo.reserveRefundSubmission(row.id as string);
    expect(result.outcome).toBe("RESERVED");
    if (result.outcome !== "RESERVED") throw new Error("unreachable");
    expect(result.payment.refund_initiation_status).toBe("RESERVED");
    expect(result.payment.refund_requested_at).not.toBeNull();
    expect(row.refund_initiation_status).toBe("RESERVED");
  });

  it("D-RF4 a second reservation is ALREADY_RESERVED and the IS NULL predicate blocks re-write", async () => {
    const row = capturedRow();
    const first = await repo.reserveRefundSubmission(row.id as string);
    if (first.outcome !== "RESERVED") throw new Error("unreachable");
    const firstTimestamp = first.payment.refund_requested_at;
    const rawTimestamp = row.refund_requested_at;

    const second = await repo.reserveRefundSubmission(row.id as string);
    expect(second.outcome).toBe("ALREADY_RESERVED");
    if (second.outcome !== "ALREADY_RESERVED") throw new Error("unreachable");
    expect(second.payment.refund_requested_at).toBe(firstTimestamp);
    // The row's timestamp is byte-identical: the second UPDATE matched no rows.
    expect(row.refund_requested_at).toBe(rawTimestamp);
  });

  it("D-RF5 non-CAPTURED rows cannot acquire a CAPTURED reservation", async () => {
    fake.rowsFor(payments).push(
      paymentRow({ status: "CREATED" }),
      paymentRow({ status: "FAILED" }),
      paymentRow({ status: "REFUNDED" }),
    );
    for (const row of fake.rowsFor(payments)) {
      expect((await repo.reserveRefundSubmission(row.id as string)).outcome).toBe(
        "NOOP_STATE_CHANGED",
      );
      expect(row.refund_requested_at).toBeNull();
    }
  });

  it("D-RF6 concurrent reservations yield exactly one RESERVED", async () => {
    const row = capturedRow();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.reserveRefundSubmission(row.id as string)),
    );
    expect(results.filter((r) => r.outcome === "RESERVED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "ALREADY_RESERVED")).toHaveLength(4);
  });

  it("D-RF8/RF9 result markers persist without clearing the reservation", async () => {
    const row = capturedRow();
    const reserved = await repo.reserveRefundSubmission(row.id as string);
    if (reserved.outcome !== "RESERVED") throw new Error("unreachable");

    const submitted = await repo.markRefundSubmissionResult(row.id as string, {
      refund_provider_id: "rfnd_dz",
      refund_initiation_status: "SUBMITTED",
    });
    expect(submitted!.refund_provider_id).toBe("rfnd_dz");
    expect(submitted!.refund_initiation_status).toBe("SUBMITTED");
    expect(submitted!.refund_requested_at).toBe(reserved.payment.refund_requested_at);

    const review = await repo.markRefundSubmissionResult(row.id as string, {
      refund_initiation_status: "MANUAL_REVIEW",
      refund_initiation_reason: "AMBIGUOUS_TIMEOUT",
    });
    expect(review!.refund_initiation_reason).toBe("AMBIGUOUS_TIMEOUT");
    expect(review!.refund_requested_at).toBe(reserved.payment.refund_requested_at);
    expect(review!.refund_provider_id).toBe("rfnd_dz");
  });

  it("D-RF10 webhook/reconciliation/CAS writes preserve the refund columns", async () => {
    const row = capturedRow();
    const reserved = await repo.reserveRefundSubmission(row.id as string);
    if (reserved.outcome !== "RESERVED") throw new Error("unreachable");
    await repo.markRefundSubmissionResult(row.id as string, {
      refund_provider_id: "rfnd_dz10",
      refund_initiation_status: "SUBMITTED",
    });

    await repo.updateWebhookResult(row.id as string, WEBHOOK);
    await repo.markReconciliationResult(row.id as string, {
      reconciliation_status: "MANUAL_REVIEW",
      reconciliation_reason: "x",
      last_reconciled_at: "2026-01-01T02:00:00.000Z",
    });
    const after = await repo.compareAndSetStatus(row.id as string, "CAPTURED", "CAPTURED");

    expect(after.outcome).toBe("UPDATED");
    if (after.outcome !== "UPDATED") throw new Error("unreachable");
    expect(after.payment.refund_requested_at).toBe(reserved.payment.refund_requested_at);
    expect(after.payment.refund_provider_id).toBe("rfnd_dz10");
    expect(after.payment.refund_initiation_status).toBe("SUBMITTED");
  });

  it("D-RF12 reservation reports NOT_FOUND for a missing row", async () => {
    const result = await repo.reserveRefundSubmission("00000000-0000-4000-8000-0000000000ff");
    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("RF11 Memory and Drizzle refund-initiation semantics match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    async function run(target: PaymentRepository): Promise<Record<string, unknown> | null> {
      const created = await target.create({ razorpay_order_id: "order_rf_parity", amount: 100 });
      await target.updateWebhookResult(created.id, WEBHOOK);
      const reserved = await target.reserveRefundSubmission(created.id);
      if (reserved.outcome !== "RESERVED") throw new Error(`expected RESERVED, got ${reserved.outcome}`);
      await target.markRefundSubmissionResult(created.id, {
        refund_provider_id: "rfnd_parity",
        refund_initiation_status: "SUBMITTED",
      });
      const second = await target.reserveRefundSubmission(created.id);
      expect(second.outcome).toBe("ALREADY_RESERVED");
      return snapshot(await target.getById(created.id));
    }

    const memoryRepo = new MemoryPaymentRepository();
    const memory = await run(memoryRepo);
    const drizzle = await run(repo);
    expect(drizzle).toEqual(memory);
  });
});
