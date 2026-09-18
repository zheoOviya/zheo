import { describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../lib/dbType";
import {
  classifyNotificationError,
  DrizzleNotificationRepository,
  MemoryNotificationRepository,
  type NotificationDTO,
  type NotificationRepository,
} from "./notificationRepository";

// ============================================================
// NOTIFICATION-DELIVERY-CONCURRENCY-A2 — atomic attempt reservation and
// terminal-state CAS for the notification outbox.
//
// `attempts` now counts provider attempts RESERVED/INVOKED: `reserveAttempt`
// atomically increments it (status=PENDING + due + attempts=expected + max
// guard), and every terminal/retry write only mutates the exact reserved
// attempt, so a stale worker can neither duplicate a send nor regress
// SENT/FAILED.
//
// The in-memory stand-in below interprets the Postgres conditions the
// repository builds (eq/lt/lte) and the atomic `attempts = attempts + 1` SQL
// expression produced by drizzle-orm, so the same contract suite runs against
// the real DrizzleNotificationRepository code path without a live connection.
// Durable/concurrent atomicity is proven against real PostgreSQL by
// apps/api/integration/realPgNotificationDeliveryConcurrency.ts.
// ============================================================

interface FakeDb {
  db: DrizzleDb;
  rows: () => Record<string, unknown>[];
  setCalls: () => Array<Record<string, unknown>>;
  seed: (row: Record<string, unknown>) => void;
  aggregateColumns: () => string[];
  aggregateSelectCalls: () => number;
  rowQueries: () => RowQueryTrace[];
}

/**
 * Captured shape of one plain row-select (`select().from().where()...`) so the
 * OPER_5 boundedness contract can assert the DB-side `where`/`orderBy`/`limit`
 * chain and the number of rows the database actually emitted to the app.
 */
interface RowQueryTrace {
  where: unknown;
  orderBy: unknown[];
  limit: number | undefined;
  emitted: number;
}

/** Awaitable + chainable shape the repository casts its grouped aggregate to. */
interface AggregateGroupQuery extends Promise<Record<string, unknown>[]> {
  where: (condition: unknown) => AggregateGroupQuery;
  groupBy: (...columns: unknown[]) => AggregateGroupQuery;
  orderBy: (...columns: unknown[]) => AggregateGroupQuery;
}

/** Awaitable + chainable shape of the bounded row select used by `listPending`. */
interface BoundedRowQuery extends Promise<Record<string, unknown>[]> {
  where: (condition: unknown) => BoundedRowQuery;
  orderBy: (...columns: unknown[]) => BoundedRowQuery;
  limit: (count: number) => BoundedRowQuery;
}

interface Pair {
  col: string;
  op: "=" | "<=" | "<";
  val: unknown;
}

function flattenChunks(cond: unknown, out: Array<Record<string, unknown>>): void {
  if (!cond || typeof cond !== "object") return;
  const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return;
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    // The `sql` template pushes raw interpolated values (strings, Dates, ...)
    // as-is, while condition helpers wrap values in `Param`. Treat both as
    // parameters.
    if (typeof chunk !== "object") {
      out.push({ kind: "param", val: chunk });
      continue;
    }
    const c = chunk as {
      queryChunks?: unknown[];
      encoder?: unknown;
      name?: unknown;
      value?: unknown;
    };
    if (Array.isArray(c.queryChunks)) {
      flattenChunks(c, out);
    } else if ("encoder" in c) {
      out.push({ kind: "param", val: c.value });
    } else if (typeof c.name === "string") {
      out.push({ kind: "col", col: c.name });
    } else if (Array.isArray(c.value)) {
      out.push({ kind: "text", text: c.value.join("") });
    } else {
      out.push({ kind: "param", val: chunk });
    }
  }
}

function parsePairs(cond: unknown): Pair[] {
  const tokens: Array<Record<string, unknown>> = [];
  flattenChunks(cond, tokens);
  const pairs: Pair[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== "col") continue;
    let j = i + 1;
    let op: Pair["op"] = "=";
    while (j < tokens.length && tokens[j]!.kind !== "param" && tokens[j]!.kind !== "col") {
      const text = tokens[j]!.text;
      if (typeof text === "string") {
        if (text.includes("<=")) op = "<=";
        else if (text.includes("<")) op = "<";
        else if (text.includes("=")) op = "=";
      }
      j += 1;
    }
    if (j < tokens.length && tokens[j]!.kind === "param") {
      pairs.push({ col: tok.col as string, op, val: tokens[j]!.val });
    }
  }
  return pairs;
}

function compare(left: unknown, right: unknown): number {
  const l = left instanceof Date ? left.getTime() : (left as number);
  const r = right instanceof Date ? right.getTime() : (right as number);
  if (typeof l === "number" && typeof r === "number") return l - r;
  return String(l).localeCompare(String(r));
}

function notNullColumns(cond: unknown): string[] {
  const tokens: Array<Record<string, unknown>> = [];
  flattenChunks(cond, tokens);
  const cols: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== "col") continue;
    const next = tokens[i + 1];
    const text = next && next.kind === "text" ? (next.text as string) : "";
    if (/is\s+not\s+null/i.test(text)) cols.push(tok.col as string);
  }
  return cols;
}

/** Parse a Drizzle order expression (`asc(col)`/`desc(col)`) into column + direction. */
function parseOrder(expr: unknown): { col: string; dir: "asc" | "desc" } {
  const tokens: Array<Record<string, unknown>> = [];
  flattenChunks(expr, tokens);
  const colTok = tokens.find((t) => t.kind === "col");
  if (!colTok) throw new Error("order expression is missing its column");
  const dir = tokens.some((t) => t.kind === "text" && /desc/i.test(String(t.text)))
    ? "desc"
    : "asc";
  return { col: colTok.col as string, dir };
}

function predicate(cond: unknown): (row: Record<string, unknown>) => boolean {
  const pairs = parsePairs(cond);
  const notNull = notNullColumns(cond);
  return (row) =>
    notNull.every((col) => row[col] !== null && row[col] !== undefined) &&
    pairs.every(({ col, op, val }) => {
      if (op === "<=") return compare(row[col], val) <= 0;
      if (op === "<") return compare(row[col], val) < 0;
      return row[col] === val;
    });
}

function applySet(row: Record<string, unknown>, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (key === "attempts" && typeof value !== "number") {
      // The repository passed an SQL expression (atomic `attempts + 1`).
      row.attempts = Number(row.attempts ?? 0) + 1;
    } else {
      row[key] = value;
    }
  }
}

type AggToken =
  | { kind: "text"; text: string }
  | { kind: "col"; col: string }
  | { kind: "param"; val: unknown };

function aggTokens(field: unknown): AggToken[] {
  const out: Array<Record<string, unknown>> = [];
  flattenChunks(field, out);
  return out as unknown as AggToken[];
}

function referencedColumns(fields: Record<string, unknown>): string[] {
  const cols: string[] = [];
  for (const field of Object.values(fields)) {
    for (const tok of aggTokens(field)) if (tok.kind === "col") cols.push(tok.col);
  }
  return cols;
}

// Bounded interpreter for the single PII-free aggregate query produced by
// `getOperabilityMetrics`: `count(*) FILTER (WHERE ...)`, `MIN(created_at)`,
// `MAX(attempts)`. It executes the real query semantics against the fake rows
// so the Drizzle code path is proven, not merely shape-inspected.
function evalAggregateField(rows: Record<string, unknown>[], field: unknown): unknown {
  const tokens = aggTokens(field);
  const text = tokens
    .filter((t): t is { kind: "text"; text: string } => t.kind === "text")
    .map((t) => t.text)
    .join("");
  const func = text.includes("count(")
    ? "count"
    : text.includes("min(")
      ? "min"
      : text.includes("max(")
        ? "max"
        : null;
  if (!func) throw new Error(`unsupported aggregate field: ${text}`);

  const statusParam = tokens.find(
    (t) => t.kind === "param" && ["PENDING", "FAILED", "SENT"].includes(t.val as string),
  );
  const statusFilter =
    statusParam && statusParam.kind === "param" ? (statusParam.val as string) : null;

  let dateCmp: { val: unknown; op: "<=" | ">" } | null = null;
  const naIdx = tokens.findIndex((t) => t.kind === "col" && t.col === "next_attempt_at");
  if (naIdx >= 0) {
    let op: "<=" | ">" = "<=";
    for (let j = naIdx + 1; j < tokens.length; j += 1) {
      const tok = tokens[j]!;
      if (tok.kind === "text") {
        if (tok.text.includes("<=")) op = "<=";
        else if (tok.text.includes(">")) op = ">";
      } else if (tok.kind === "param") {
        dateCmp = { val: tok.val, op };
        break;
      }
    }
  }

  const matched = rows.filter((r) => {
    if (statusFilter !== null && r.status !== statusFilter) return false;
    if (dateCmp) {
      const c = compare(r.next_attempt_at, dateCmp.val);
      if (dateCmp.op === ">" ? !(c > 0) : !(c <= 0)) return false;
    }
    return true;
  });

  if (func === "count") return matched.length;
  if (func === "min") {
    if (matched.length === 0) return null;
    return matched.reduce(
      (min, r) => (compare(r.created_at, min) < 0 ? r.created_at : min),
      matched[0]!.created_at,
    );
  }
  if (matched.length === 0) return null;
  return matched.reduce(
    (mx, r) => Math.max(mx, Number(r.attempts)),
    Number.NEGATIVE_INFINITY,
  );
}

function runAggregate(
  rows: Record<string, unknown>[],
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    out[key] = evalAggregateField(rows, field);
  }
  return out;
}

// ---- Bounded interpreter for the GROUP BY aggregate produced by
// `getOperabilityHealth`: `SELECT channel, count(*) FILTER (...), CASE ... END
// ... GROUP BY channel[, case] ORDER BY ...`. It executes the real query
// semantics against the fake rows so the Drizzle path is proven, not merely
// shape-inspected. `isNotNull` filtering is handled by `predicate`.

function columnNameOf(expr: unknown): string | null {
  if (!expr || typeof expr !== "object") return null;
  const c = expr as { name?: unknown; queryChunks?: unknown };
  if (typeof c.name === "string" && !Array.isArray(c.queryChunks)) return c.name;
  return null;
}

function isCaseExpr(field: unknown): boolean {
  return aggTokens(field).some(
    (t) => t.kind === "text" && t.text.toLowerCase().includes("case when"),
  );
}

function evalCaseCategory(row: Record<string, unknown>, field: unknown): string {
  const tokens = aggTokens(field);
  const colTok = tokens.find((t) => t.kind === "col") as { col: string } | undefined;
  if (!colTok) throw new Error("case expression is missing its source column");
  const thenIdx = tokens.findIndex((t) => t.kind === "text" && /then/i.test(t.text));
  const elseIdx = tokens.findIndex((t) => t.kind === "text" && /else/i.test(t.text));
  const inParams = tokens
    .filter((t, i) => t.kind === "param" && i < thenIdx)
    .map((t) => (t as { val: unknown }).val);
  const thenVal = tokens.find((t, i) => t.kind === "param" && i > thenIdx && i < elseIdx) as
    | { val: unknown }
    | undefined;
  const elseVal = tokens.find((t, i) => t.kind === "param" && i > elseIdx) as
    | { val: unknown }
    | undefined;
  return inParams.includes(row[colTok.col]) ? String(thenVal?.val) : String(elseVal?.val);
}

function evalGroupExpr(row: Record<string, unknown>, expr: unknown): unknown {
  const col = columnNameOf(expr);
  if (col !== null) return row[col];
  if (isCaseExpr(expr)) return evalCaseCategory(row, expr);
  throw new Error("unsupported group expression");
}

function runGroupedAggregate(
  rows: Record<string, unknown>[],
  fields: Record<string, unknown>,
  whereCond: unknown,
  groupExprs: unknown[],
  orderExprs: unknown[],
): Record<string, unknown>[] {
  const filtered = whereCond === undefined ? rows : rows.filter(predicate(whereCond));
  const groups = new Map<string, { keyVals: unknown[]; rows: Record<string, unknown>[] }>();
  for (const row of filtered) {
    const keyVals = groupExprs.map((expr) => evalGroupExpr(row, expr));
    const key = JSON.stringify(keyVals);
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { keyVals, rows: [row] });
  }

  const records = Array.from(groups.values()).map((group) => {
    const rec: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      const col = columnNameOf(field);
      if (col !== null) rec[key] = group.rows[0]![col];
      else if (isCaseExpr(field)) rec[key] = evalCaseCategory(group.rows[0]!, field);
      else rec[key] = evalAggregateField(group.rows, field);
    }
    return { rec, keyVals: group.keyVals };
  });

  const orderIndexes = orderExprs.map((expr) => groupExprs.findIndex((g) => g === expr));
  records.sort((a, b) => {
    for (const idx of orderIndexes) {
      if (idx < 0) continue;
      const c = compare(a.keyVals[idx], b.keyVals[idx]);
      if (c !== 0) return c;
    }
    return 0;
  });
  return records.map((r) => r.rec);
}

function createFakeDb(): FakeDb {
  const rows: Record<string, unknown>[] = [];
  const setCalls: Array<Record<string, unknown>> = [];
  let aggregateSelectCalls = 0;
  let aggregateColumnsSeen: string[] = [];
  const rowQueries: RowQueryTrace[] = [];

  const rowSelect = () => ({
    from: () => {
      let whereCond: unknown;
      let orderExprs: unknown[] = [];
      let limitValue: number | undefined;
      const trace: RowQueryTrace = {
        where: undefined,
        orderBy: [],
        limit: undefined,
        emitted: 0,
      };
      rowQueries.push(trace);
      // Deferred so the synchronous `.where().orderBy().limit()` chain is fully
      // collected before the read executes. Applying order/limit here (rather
      // than in the repository) is what makes app-side full-set materialization
      // observable: `trace.emitted` reports how many rows the "database" handed
      // to the application.
      const exec = (): Record<string, unknown>[] => {
        trace.where = whereCond;
        trace.orderBy = orderExprs;
        trace.limit = limitValue;
        let result = rows.filter(predicate(whereCond));
        if (orderExprs.length > 0) {
          const specs = orderExprs.map(parseOrder);
          result = [...result].sort((a, b) => {
            for (const spec of specs) {
              const c = compare(a[spec.col], b[spec.col]);
              if (c !== 0) return spec.dir === "asc" ? c : -c;
            }
            return 0;
          });
        }
        if (limitValue !== undefined) result = result.slice(0, limitValue);
        trace.emitted = result.length;
        return result;
      };
      const p = Promise.resolve().then(exec) as unknown as BoundedRowQuery & {
        for: () => BoundedRowQuery;
      };
      p.for = () => p;
      p.where = (cond) => {
        whereCond = cond;
        return p;
      };
      p.orderBy = (...cols) => {
        orderExprs = cols;
        return p;
      };
      p.limit = (count) => {
        limitValue = count;
        return p;
      };
      return p;
    },
  });

  const db = {
    select: (fields?: Record<string, unknown>) => {
      if (fields) {
        aggregateSelectCalls += 1;
        aggregateColumnsSeen = referencedColumns(fields);
        return {
          from: () => {
            let whereCond: unknown;
            let groupExprs: unknown[] = [];
            let orderExprs: unknown[] = [];
            // Deferred so the synchronous `.where().groupBy().orderBy()` chain
            // is fully collected before the aggregate executes.
            const exec = (): Record<string, unknown>[] =>
              groupExprs.length === 0
                ? [runAggregate(rows, fields)]
                : runGroupedAggregate(rows, fields, whereCond, groupExprs, orderExprs);
            const p = Promise.resolve().then(exec) as AggregateGroupQuery;
            p.where = (cond) => {
              whereCond = cond;
              return p;
            };
            p.groupBy = (...cols) => {
              groupExprs = cols;
              return p;
            };
            p.orderBy = (...cols) => {
              orderExprs = cols;
              return p;
            };
            return p;
          },
        };
      }
      return rowSelect();
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        const now = new Date();
        rows.push({
          id: values.id,
          user_id: values.user_id,
          channel: values.channel,
          to_address: values.to_address,
          body: values.body,
          status: "PENDING",
          attempts: 0,
          last_error: null,
          next_attempt_at: now,
          created_at: now,
          ...values,
        });
        return [];
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: (cond: unknown) => {
            const pred = predicate(cond);
            const matched: Record<string, unknown>[] = [];
            for (const row of rows) {
              if (pred(row)) {
                applySet(row, values);
                matched.push({ ...row });
              }
            }
            const result = Promise.resolve(matched) as Promise<unknown[]> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = () => Promise.resolve(matched);
            return result;
          },
        };
      },
    }),
    transaction: async (fn: (tx: DrizzleDb) => Promise<unknown>) => fn(db as unknown as DrizzleDb),
    delete: () => ({ where: () => Promise.resolve([]) }),
  } as unknown as DrizzleDb;

  return {
    db,
    rows: () => rows,
    setCalls: () => setCalls,
    seed: (row) => {
      rows.push(row);
    },
    aggregateColumns: () => aggregateColumnsSeen,
    aggregateSelectCalls: () => aggregateSelectCalls,
    rowQueries: () => rowQueries,
  };
}

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2999-01-01T00:00:00.000Z");

function input() {
  return {
    user_id: "00000000-0000-4000-8000-000000000001",
    channel: "sms" as const,
    to_address: "+9100000000",
    body: "hello",
  };
}

function snapshot(repo: NotificationRepository): Promise<NotificationDTO[]> {
  return repo.listAll();
}

// ============================================================
// Shared contract suite — runs identically against the authoritative memory
// backend and the Drizzle backend (over the fake SQL interpreter). This is
// the T17 memory/Postgres semantic-parity proof at the unit level.
// ============================================================

function reservationContract(label: string, make: () => NotificationRepository): void {
  describe(`${label} reservation + terminal CAS contract`, () => {
    it("T1: reserving an eligible PENDING row succeeds", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r = await repo.reserveAttempt(n.id, 0, new Date());
      expect(r).not.toBeNull();
      expect(r!.status).toBe("PENDING");
      expect(r!.attempts).toBe(1);
    });

    it("T2: reservation increments attempts exactly once", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const first = await repo.reserveAttempt(n.id, 0, new Date());
      expect(first!.attempts).toBe(1);
      const second = await repo.reserveAttempt(n.id, 0, new Date());
      expect(second).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.attempts).toBe(1);
    });

    it("T3: reservation with a future next_attempt_at loses", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markRetryable(n.id, r1!.attempts, "later", FUTURE);
      const r2 = await repo.reserveAttempt(n.id, 1, new Date());
      expect(r2).toBeNull();
    });

    it("T4: reservation on a SENT row loses", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markSent(n.id, r1!.attempts);
      expect(await repo.reserveAttempt(n.id, 1, new Date())).toBeNull();
    });

    it("T5: reservation on a FAILED row loses", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markDead(n.id, r1!.attempts, "dead");
      expect(await repo.reserveAttempt(n.id, 1, new Date())).toBeNull();
    });

    it("T6: a stale expectedAttempts token loses", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      await repo.reserveAttempt(n.id, 0, new Date());
      expect(await repo.reserveAttempt(n.id, 0, new Date())).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.attempts).toBe(1);
    });

    it("T7: markSent succeeds only for the matching reserved attempt", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      expect(await repo.markSent(n.id, 0)).toBeNull();
      const sent = await repo.markSent(n.id, r1!.attempts);
      expect(sent).not.toBeNull();
      expect(sent!.status).toBe("SENT");
      expect(sent!.attempts).toBe(1);
    });

    it("T8: a stale markRetryable cannot regress SENT", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markSent(n.id, r1!.attempts);
      expect(await repo.markRetryable(n.id, r1!.attempts, "stale", PAST)).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.status).toBe("SENT");
    });

    it("T9: a stale markDead cannot regress SENT", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markSent(n.id, r1!.attempts);
      expect(await repo.markDead(n.id, r1!.attempts, "stale")).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.status).toBe("SENT");
    });

    it("T10: a stale markSent cannot resurrect FAILED", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      await repo.markDead(n.id, r1!.attempts, "dead");
      expect(await repo.markSent(n.id, r1!.attempts)).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.status).toBe("FAILED");
    });

    it("T11: retryable failure keeps attempts unchanged after reservation", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      const retried = await repo.markRetryable(n.id, r1!.attempts, "boom", PAST);
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe("PENDING");
      expect(retried!.attempts).toBe(1);
      expect(retried!.last_error).toBe("boom");
    });

    it("T12: dead failure keeps attempts unchanged after reservation", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const r1 = await repo.reserveAttempt(n.id, 0, new Date());
      const dead = await repo.markDead(n.id, r1!.attempts, "boom");
      expect(dead).not.toBeNull();
      expect(dead!.status).toBe("FAILED");
      expect(dead!.attempts).toBe(1);
    });

    it("T13: the fifth failed attempt ends FAILED with attempts=5", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const due = new Date();
      for (let i = 0; i < 4; i += 1) {
        const r = await repo.reserveAttempt(n.id, i, due);
        expect(r!.attempts).toBe(i + 1);
        await repo.markRetryable(n.id, r!.attempts, "e", due);
      }
      const fifth = await repo.reserveAttempt(n.id, 4, due);
      expect(fifth!.attempts).toBe(5);
      await repo.markDead(n.id, fifth!.attempts, "final");
      const [row] = await snapshot(repo);
      expect(row!.status).toBe("FAILED");
      expect(row!.attempts).toBe(5);
    });

    it("T14: a sixth reservation (and provider call) is impossible", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const due = new Date();
      for (let i = 0; i < 5; i += 1) {
        const r = await repo.reserveAttempt(n.id, i, due);
        expect(r).not.toBeNull();
        await repo.markRetryable(n.id, r!.attempts, "e", due);
      }
      expect(await repo.reserveAttempt(n.id, 5, due)).toBeNull();
      const [row] = await snapshot(repo);
      expect(row!.attempts).toBe(5);
    });

    it("reservation on an unknown id returns null (no throw)", async () => {
      const repo = make();
      const missing = "00000000-0000-4000-8000-0000000000ff";
      expect(await repo.reserveAttempt(missing, 0, new Date())).toBeNull();
      expect(await repo.markSent(missing, 1)).toBeNull();
      expect(await repo.markRetryable(missing, 1, "e", PAST)).toBeNull();
      expect(await repo.markDead(missing, 1, "e")).toBeNull();
    });

    it("concurrent reservation of one PENDING row has exactly one winner", async () => {
      const repo = make();
      const n = await repo.enqueue(input());
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.reserveAttempt(n.id, 0, new Date())),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const [row] = await snapshot(repo);
      expect(row!.attempts).toBe(1);
    });
  });
}

reservationContract("MemoryNotificationRepository", () => new MemoryNotificationRepository());
reservationContract(
  "DrizzleNotificationRepository",
  () => new DrizzleNotificationRepository(createFakeDb().db),
);

// ============================================================
// Drizzle-specific write-shape assertions.
// ============================================================

describe("DrizzleNotificationRepository reservation write shape", () => {
  it("reserveAttempt uses an atomic SQL increment; mark* never touch attempts", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    const r = await repo.reserveAttempt(n.id, 0, new Date());
    expect(r).not.toBeNull();

    const reserveSet = fake.setCalls()[0]!;
    expect(typeof reserveSet.attempts).not.toBe("number");
    expect(
      Array.isArray((reserveSet.attempts as { queryChunks?: unknown[] }).queryChunks),
    ).toBe(true);

    await repo.markSent(r!.id, r!.attempts);
    await repo.markRetryable(r!.id, r!.attempts, "boom", PAST);
    await repo.markDead(r!.id, r!.attempts, "dead");
    for (const call of fake.setCalls().slice(1)) {
      expect(call).not.toHaveProperty("attempts");
    }
  });

  it("listPending filters PENDING + due, excluding terminal and backed-off rows", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const due = await repo.enqueue(input());
    const backedOff = await repo.enqueue(input());
    const sent = await repo.enqueue(input());
    const failed = await repo.enqueue(input());

    const bo = await repo.reserveAttempt(backedOff.id, 0, new Date());
    await repo.markRetryable(backedOff.id, bo!.attempts, "later", FUTURE);
    const s = await repo.reserveAttempt(sent.id, 0, new Date());
    await repo.markSent(sent.id, s!.attempts);
    const f = await repo.reserveAttempt(failed.id, 0, new Date());
    await repo.markDead(failed.id, f!.attempts, "dead");

    const pending = await repo.listPending();
    const ids = pending.map((p) => p.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(backedOff.id);
    expect(ids).not.toContain(sent.id);
    expect(ids).not.toContain(failed.id);
  });
});

// ============================================================
// T17: memory/Postgres observable parity for identical sequences.
// ============================================================

describe("Memory/Postgres reservation parity", () => {
  it("identical operation sequences yield identical observable state", async () => {
    const memory = new MemoryNotificationRepository();
    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);

    const run = async (repo: NotificationRepository) => {
      const n = await repo.enqueue(input());
      const due = new Date();
      const r1 = await repo.reserveAttempt(n.id, 0, due);
      await repo.markRetryable(n.id, r1!.attempts, "e1", due);
      const r2 = await repo.reserveAttempt(n.id, 1, due);
      await repo.markSent(n.id, r2!.attempts);
      return (await snapshot(repo)).map((r) => ({
        status: r.status,
        attempts: r.attempts,
        last_error: r.last_error,
      }));
    };

    const memoryState = await run(memory);
    const drizzleState = await run(drizzle);
    expect(drizzleState).toEqual(memoryState);
    expect(memoryState[0]!.status).toBe("SENT");
    expect(memoryState[0]!.attempts).toBe(2);
  });
});

// ============================================================
// NOTIFICATION-OPERABILITY-A2 — PII-free aggregate backlog/failure metrics.
// O1-O7 and O9-O12 repository-level (O8 and O13-O16 live in the admin route suite).
// ============================================================

describe("Notification operability metrics (NOTIFICATION-OPERABILITY-A2)", () => {
  const NOW = new Date("2030-01-01T00:00:00.000Z");
  const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  interface Mixed {
    repo: MemoryNotificationRepository;
    due: NotificationDTO;
    future: NotificationDTO;
    sent: NotificationDTO;
    failed: NotificationDTO;
  }

  // Deterministic mixed dataset. FAILED is created (and driven to attempts=3)
  // BEFORE any PENDING row so the oldest/max-attempt exclusions are provable.
  async function buildMixed(): Promise<Mixed> {
    const repo = new MemoryNotificationRepository();
    const failed0 = await repo.enqueue(input());
    const rf1 = await repo.reserveAttempt(failed0.id, 0, new Date());
    await repo.markRetryable(failed0.id, rf1!.attempts, "e1", PAST);
    const rf2 = await repo.reserveAttempt(failed0.id, 1, new Date());
    await repo.markRetryable(failed0.id, rf2!.attempts, "e2", PAST);
    const rf3 = await repo.reserveAttempt(failed0.id, 2, new Date());
    const failed = (await repo.markDead(failed0.id, rf3!.attempts, "dead"))!;

    await tick();
    const due = await repo.enqueue(input());

    const future0 = await repo.enqueue(input());
    const rfu = await repo.reserveAttempt(future0.id, 0, new Date());
    const future = (await repo.markRetryable(future0.id, rfu!.attempts, "later", FUTURE_AT))!;

    const sent0 = await repo.enqueue(input());
    const rs = await repo.reserveAttempt(sent0.id, 0, new Date());
    const sent = (await repo.markSent(sent0.id, rs!.attempts))!;

    return { repo, due, future, sent, failed };
  }

  it("O1: empty store returns truthful zero/null metrics", async () => {
    const repo = new MemoryNotificationRepository();
    expect(await repo.getOperabilityMetrics(NOW)).toEqual({
      pending_total: 0,
      due_pending: 0,
      future_retry: 0,
      failed_total: 0,
      sent_total: 0,
      oldest_pending_at: null,
      max_attempt_pending: null,
    });
  });

  it("O2: pending_total counts all PENDING only", async () => {
    const { repo } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.pending_total).toBe(2);
  });

  it("O3: due_pending counts PENDING with next_attempt_at <= now", async () => {
    const { repo, due, future } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.due_pending).toBe(1);
    expect(new Date(due.next_attempt_at).getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(new Date(future.next_attempt_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("O4: future_retry counts PENDING with next_attempt_at > now", async () => {
    const { repo } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.future_retry).toBe(1);
  });

  it("O5: FAILED is counted separately", async () => {
    const { repo } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.failed_total).toBe(1);
  });

  it("O6: SENT is counted separately", async () => {
    const { repo } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.sent_total).toBe(1);
  });

  it("O10: pending_total = due_pending + future_retry", async () => {
    const { repo } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.pending_total).toBe(m.due_pending + m.future_retry);
  });

  it("O7: oldest_pending_at is MIN(created_at) among PENDING only", async () => {
    const { repo, due, future, failed } = await buildMixed();
    const expected = [due.created_at, future.created_at].sort()[0]!;
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.oldest_pending_at).toBe(expected);
    // The FAILED row is strictly older yet excluded from the PENDING minimum.
    expect(failed.created_at.localeCompare(expected)).toBeLessThan(0);
    expect(m.oldest_pending_at).not.toBe(failed.created_at);
  });

  it("O9: max_attempt_pending is MAX(attempts) among PENDING only", async () => {
    const { repo, failed } = await buildMixed();
    const m = await repo.getOperabilityMetrics(NOW);
    expect(m.max_attempt_pending).toBe(1);
    expect(failed.attempts).toBe(3);
  });

  it("O11: next_attempt_at === now is DUE; now + 1ms is FUTURE", async () => {
    const repo = new MemoryNotificationRepository();
    const equal = await repo.enqueue(input());
    const at = new Date(equal.next_attempt_at);
    expect((await repo.getOperabilityMetrics(at)).due_pending).toBe(1);

    const plus = await repo.enqueue(input());
    const r = await repo.reserveAttempt(plus.id, 0, new Date());
    await repo.markRetryable(plus.id, r!.attempts, "later", new Date(at.getTime() + 1));
    const m = await repo.getOperabilityMetrics(at);
    expect(m.due_pending).toBe(1);
    expect(m.future_retry).toBe(1);
  });

  it("O12: Memory and Drizzle observable semantics match on identical rows", async () => {
    const { repo: memory, due, future, sent, failed } = await buildMixed();
    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);
    for (const dto of [due, future, sent, failed]) {
      fake.seed({
        id: dto.id,
        user_id: dto.user_id,
        channel: dto.channel,
        to_address: dto.to_address,
        body: dto.body,
        status: dto.status,
        attempts: dto.attempts,
        last_error: dto.last_error,
        next_attempt_at: new Date(dto.next_attempt_at),
        created_at: new Date(dto.created_at),
      });
    }
    const memoryMetrics = await memory.getOperabilityMetrics(NOW);
    const drizzleMetrics = await drizzle.getOperabilityMetrics(NOW);
    expect(drizzleMetrics).toEqual(memoryMetrics);
  });

  it("aggregate query is one DB-side read, selects no PII columns, and never calls listAll", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    await repo.enqueue(input());

    const m = await repo.getOperabilityMetrics(new Date());
    expect(fake.aggregateSelectCalls()).toBe(1);
    const cols = fake.aggregateColumns();
    expect(cols).not.toContain("body");
    expect(cols).not.toContain("to_address");
    expect(cols).not.toContain("last_error");
    expect(cols).not.toContain("user_id");
    expect(new Set(cols)).toEqual(
      new Set(["status", "next_attempt_at", "created_at", "attempts"]),
    );

    // Independence: the metric path must not depend on the full-row listAll.
    let listAllCalled = false;
    const original = repo.listAll.bind(repo);
    (repo as unknown as { listAll: () => Promise<unknown[]> }).listAll = async () => {
      listAllCalled = true;
      return [];
    };
    const m2 = await repo.getOperabilityMetrics(new Date());
    expect(listAllCalled).toBe(false);
    expect(m2.pending_total).toBe(1);
    expect(m2.due_pending).toBe(1);
    (repo as unknown as { listAll: typeof original }).listAll = original;
  });
});

// ============================================================
// NOTIFICATION-OPERABILITY-READMODEL-A2 — PII-safe channel/failure-category
// aggregate health read model. R1-R14 repository-level; A1-A18 live in the
// admin route suite.
// ============================================================

describe("Notification operability health read model (NOTIFICATION-OPERABILITY-READMODEL-A2)", () => {
  const NOW = new Date("2030-01-01T00:00:00.000Z");
  const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");
  const RAW_UNKNOWN_ERROR = "RAW_PROVIDER_SECRET_TEXT";
  const RAW_CONFIG_ERROR_SMS = "sms provider not configured";
  const RAW_CONFIG_ERROR_EMAIL = "email provider not configured";

  const EXPECTED_CHANNELS = [
    { channel: "email", pending: 1, due: 0, failed: 2, sent: 0 },
    { channel: "sms", pending: 2, due: 1, failed: 1, sent: 1 },
  ];
  const EXPECTED_FAILURE_CATEGORIES = [
    { channel: "email", safe_error_category: "PROVIDER_UNCONFIGURED", count: 1 },
    { channel: "email", safe_error_category: "UNKNOWN", count: 2 },
    { channel: "sms", safe_error_category: "PROVIDER_UNCONFIGURED", count: 1 },
    { channel: "sms", safe_error_category: "UNKNOWN", count: 1 },
  ];

  function enqueueFor(repo: MemoryNotificationRepository, channel: "sms" | "email") {
    return repo.enqueue({ ...input(), channel });
  }

  async function driveToFailed(
    repo: MemoryNotificationRepository,
    channel: "sms" | "email",
    error: string,
  ): Promise<NotificationDTO> {
    const n = await enqueueFor(repo, channel);
    const r = await repo.reserveAttempt(n.id, 0, new Date());
    return (await repo.markDead(n.id, r!.attempts, error))!;
  }

  async function driveToRetry(
    repo: MemoryNotificationRepository,
    channel: "sms" | "email",
    error: string,
    next: Date,
  ): Promise<NotificationDTO> {
    const n = await enqueueFor(repo, channel);
    const r = await repo.reserveAttempt(n.id, 0, new Date());
    return (await repo.markRetryable(n.id, r!.attempts, error, next))!;
  }

  async function driveToSent(
    repo: MemoryNotificationRepository,
    channel: "sms" | "email",
  ): Promise<NotificationDTO> {
    const n = await enqueueFor(repo, channel);
    const r = await repo.reserveAttempt(n.id, 0, new Date());
    return (await repo.markSent(n.id, r!.attempts))!;
  }

  interface HealthFixture {
    repo: MemoryNotificationRepository;
    smsDue: NotificationDTO;
    smsFuture: NotificationDTO;
    smsFailedConfig: NotificationDTO;
    smsSent: NotificationDTO;
    emailFuture: NotificationDTO;
    emailFailedConfig: NotificationDTO;
    emailFailedUnknown: NotificationDTO;
  }

  async function buildHealthFixture(): Promise<HealthFixture> {
    const repo = new MemoryNotificationRepository();
    const smsDue = await enqueueFor(repo, "sms");
    const smsFuture = await driveToRetry(repo, "sms", RAW_UNKNOWN_ERROR, FUTURE_AT);
    const smsFailedConfig = await driveToFailed(repo, "sms", RAW_CONFIG_ERROR_SMS);
    const smsSent = await driveToSent(repo, "sms");
    const emailFuture = await driveToRetry(repo, "email", RAW_UNKNOWN_ERROR, FUTURE_AT);
    const emailFailedConfig = await driveToFailed(repo, "email", RAW_CONFIG_ERROR_EMAIL);
    const emailFailedUnknown = await driveToFailed(repo, "email", RAW_UNKNOWN_ERROR);
    return {
      repo,
      smsDue,
      smsFuture,
      smsFailedConfig,
      smsSent,
      emailFuture,
      emailFailedConfig,
      emailFailedUnknown,
    };
  }

  function seedDrizzle(fake: FakeDb, dtos: NotificationDTO[]): void {
    for (const dto of dtos) {
      fake.seed({
        id: dto.id,
        user_id: dto.user_id,
        channel: dto.channel,
        to_address: dto.to_address,
        body: dto.body,
        status: dto.status,
        attempts: dto.attempts,
        last_error: dto.last_error,
        next_attempt_at: new Date(dto.next_attempt_at),
        created_at: new Date(dto.created_at),
      });
    }
  }

  it("R1: empty dataset yields deterministic empty aggregates", async () => {
    const repo = new MemoryNotificationRepository();
    expect(await repo.getOperabilityHealth(NOW)).toEqual({ channels: [], failure_categories: [] });
  });

  it("R2: PENDING is counted as pending", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    expect(h.channels.find((c) => c.channel === "sms")!.pending).toBe(2);
    expect(h.channels.find((c) => c.channel === "email")!.pending).toBe(1);
  });

  it("R3: due PENDING is counted as both pending and due", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    const sms = h.channels.find((c) => c.channel === "sms")!;
    expect(sms.pending).toBe(2);
    expect(sms.due).toBe(1);
    expect(sms.due).toBeLessThanOrEqual(sms.pending);
  });

  it("R4: future PENDING is counted pending but NOT due", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    const email = h.channels.find((c) => c.channel === "email")!;
    expect(email.pending).toBe(1);
    expect(email.due).toBe(0);
  });

  it("R5: FAILED is counted as failed", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    expect(h.channels.find((c) => c.channel === "sms")!.failed).toBe(1);
    expect(h.channels.find((c) => c.channel === "email")!.failed).toBe(2);
  });

  it("R6: SENT is counted as sent", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    expect(h.channels.find((c) => c.channel === "sms")!.sent).toBe(1);
    expect(h.channels.find((c) => c.channel === "email")!.sent).toBe(0);
  });

  it("R7: channel separation is exact and deterministic", async () => {
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    expect(h.channels).toEqual(EXPECTED_CHANNELS);
    expect(h.channels.map((c) => c.channel)).toEqual(["email", "sms"]);
    // No fabricated channels: only channels actually represented appear.
    expect(h.channels).toHaveLength(2);
  });

  it("R8: multiple records aggregate exactly across both dimensions", async () => {
    const { repo } = await buildHealthFixture();
    expect(await repo.getOperabilityHealth(NOW)).toEqual({
      channels: EXPECTED_CHANNELS,
      failure_categories: EXPECTED_FAILURE_CATEGORIES,
    });
  });

  it("R9: known unconfigured CONFIG_ERROR maps to PROVIDER_UNCONFIGURED", async () => {
    expect(classifyNotificationError(RAW_CONFIG_ERROR_SMS)).toBe("PROVIDER_UNCONFIGURED");
    expect(classifyNotificationError(RAW_CONFIG_ERROR_EMAIL)).toBe("PROVIDER_UNCONFIGURED");
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    const smsConfig = h.failure_categories.find(
      (c) => c.channel === "sms" && c.safe_error_category === "PROVIDER_UNCONFIGURED",
    );
    expect(smsConfig!.count).toBe(1);
  });

  it("R10: unknown/unmapped error maps to UNKNOWN", async () => {
    expect(classifyNotificationError(RAW_UNKNOWN_ERROR)).toBe("UNKNOWN");
    expect(classifyNotificationError(null)).toBeNull();
    const { repo } = await buildHealthFixture();
    const h = await repo.getOperabilityHealth(NOW);
    const emailUnknown = h.failure_categories.find(
      (c) => c.channel === "email" && c.safe_error_category === "UNKNOWN",
    );
    expect(emailUnknown!.count).toBe(2);
  });

  it("R11: raw last_error never appears in the returned aggregate model", async () => {
    const { repo } = await buildHealthFixture();
    const serialized = JSON.stringify(await repo.getOperabilityHealth(NOW));
    expect(serialized).not.toContain(RAW_UNKNOWN_ERROR);
    expect(serialized).not.toContain(RAW_CONFIG_ERROR_SMS);
    expect(serialized).not.toContain(RAW_CONFIG_ERROR_EMAIL);
    expect(serialized).not.toContain("last_error");
  });

  it("R12: health aggregation performs no mutation", async () => {
    const { repo } = await buildHealthFixture();
    const before = JSON.stringify(await repo.listAll());
    await repo.getOperabilityHealth(NOW);
    expect(JSON.stringify(await repo.listAll())).toBe(before);

    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);
    seedDrizzle(fake, await repo.listAll());
    const rowsBefore = JSON.stringify(fake.rows());
    await drizzle.getOperabilityHealth(NOW);
    expect(fake.setCalls()).toHaveLength(0);
    expect(JSON.stringify(fake.rows())).toBe(rowsBefore);
  });

  it("R13: existing listPending semantics are unchanged", async () => {
    const { repo, smsDue } = await buildHealthFixture();
    const pending = await repo.listPending();
    expect(pending.map((n) => n.id)).toEqual([smsDue.id]);
    expect(pending.every((n) => n.status === "PENDING")).toBe(true);

    const limited = new MemoryNotificationRepository();
    for (let i = 0; i < 3; i += 1) await enqueueFor(limited, "sms");
    expect((await limited.listPending(2)).map((n) => n.status)).toEqual(["PENDING", "PENDING"]);
    expect(await limited.listPending(2)).toHaveLength(2);
  });

  it("R14: existing metrics semantics are unchanged", async () => {
    const { repo, smsDue, smsFuture, emailFuture } = await buildHealthFixture();
    const m = await repo.getOperabilityMetrics(NOW);
    const expectedOldest = [smsDue.created_at, smsFuture.created_at, emailFuture.created_at].sort()[0]!;
    expect(m).toEqual({
      pending_total: 3,
      due_pending: 1,
      future_retry: 2,
      failed_total: 3,
      sent_total: 1,
      oldest_pending_at: expectedOldest,
      max_attempt_pending: 1,
    });
  });

  it("parity: Memory and Drizzle health semantics match on identical rows", async () => {
    const fixture = await buildHealthFixture();
    const memory = await fixture.repo.getOperabilityHealth(NOW);

    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);
    seedDrizzle(fake, [
      fixture.smsDue,
      fixture.smsFuture,
      fixture.smsFailedConfig,
      fixture.smsSent,
      fixture.emailFuture,
      fixture.emailFailedConfig,
      fixture.emailFailedUnknown,
    ]);

    expect(await drizzle.getOperabilityHealth(NOW)).toEqual(memory);
  });

  it("health query is bounded (two group reads) and never materializes full rows", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const built = await buildHealthFixture();
    seedDrizzle(fake, await built.repo.listAll());

    const h = await repo.getOperabilityHealth(NOW);
    expect(fake.aggregateSelectCalls()).toBe(2);
    const cols = fake.aggregateColumns();
    expect(cols).not.toContain("body");
    expect(cols).not.toContain("to_address");
    expect(cols).not.toContain("user_id");
    expect(JSON.stringify(h)).not.toContain("last_error");
  });
});

// ============================================================
// NOTIFICATION-OPERABILITY-BOUNDEDNESS-A2 (OPER_5) — the delivery hot read
// must bound `ORDER BY created_at ASC, id ASC` + `LIMIT n` inside the
// database. B1-B12 run against both backends over identical rows; B13-B17
// assert the Drizzle query chain itself (shape + rows the "database" emitted);
// B18 pins the frozen listAll / operability read-model surface.
// ============================================================

describe("Notification listPending boundedness (NOTIFICATION-OPERABILITY-BOUNDEDNESS-A2)", () => {
  const READ_NOW = new Date("2030-01-01T00:00:00.000Z");
  const FUTURE_AT = new Date("2999-01-01T00:00:00.000Z");
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  function toRow(dto: NotificationDTO): Record<string, unknown> {
    return {
      id: dto.id,
      user_id: dto.user_id,
      channel: dto.channel,
      to_address: dto.to_address,
      body: dto.body,
      status: dto.status,
      attempts: dto.attempts,
      last_error: dto.last_error,
      next_attempt_at: new Date(dto.next_attempt_at),
      created_at: new Date(dto.created_at),
    };
  }

  interface BoundedFixture {
    memory: MemoryNotificationRepository;
    fake: FakeDb;
    drizzle: DrizzleNotificationRepository;
    due: NotificationDTO[];
    future: NotificationDTO;
    sent: NotificationDTO;
    failed: NotificationDTO;
  }

  // `count` due PENDING rows with strictly increasing `created_at`, plus one
  // future-retry PENDING, one SENT and one FAILED row for exclusion coverage.
  async function buildBoundedFixture(count: number): Promise<BoundedFixture> {
    const memory = new MemoryNotificationRepository();
    const due: NotificationDTO[] = [];
    for (let i = 0; i < count; i += 1) {
      await tick();
      due.push(await memory.enqueue(input()));
    }

    const future0 = await memory.enqueue(input());
    const rf = await memory.reserveAttempt(future0.id, 0, new Date());
    const future = (await memory.markRetryable(future0.id, rf!.attempts, "later", FUTURE_AT))!;

    const sent0 = await memory.enqueue(input());
    const rs = await memory.reserveAttempt(sent0.id, 0, new Date());
    const sent = (await memory.markSent(sent0.id, rs!.attempts))!;

    const failed0 = await memory.enqueue(input());
    const rd = await memory.reserveAttempt(failed0.id, 0, new Date());
    const failed = (await memory.markDead(failed0.id, rd!.attempts, "dead"))!;

    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);
    for (const dto of [...due, future, sent, failed]) fake.seed(toRow(dto));
    return { memory, fake, drizzle, due, future, sent, failed };
  }

  function lastRowQuery(fake: FakeDb): RowQueryTrace {
    const queries = fake.rowQueries();
    return queries[queries.length - 1]!;
  }

  it("B1: empty repository returns []", async () => {
    expect(await new MemoryNotificationRepository().listPending()).toEqual([]);
    expect(await new DrizzleNotificationRepository(createFakeDb().db).listPending()).toEqual([]);
  });

  it("B2: only due PENDING rows are returned", async () => {
    const { memory, drizzle, due } = await buildBoundedFixture(3);
    expect((await memory.listPending()).map((n) => n.id)).toEqual(due.map((n) => n.id));
    expect((await drizzle.listPending()).map((n) => n.id)).toEqual(due.map((n) => n.id));
  });

  it("B3: future PENDING retry is excluded", async () => {
    const { memory, drizzle, future } = await buildBoundedFixture(2);
    expect((await memory.listPending()).map((n) => n.id)).not.toContain(future.id);
    expect((await drizzle.listPending()).map((n) => n.id)).not.toContain(future.id);
  });

  it("B4: SENT is excluded", async () => {
    const { memory, drizzle, sent } = await buildBoundedFixture(2);
    expect((await memory.listPending()).map((n) => n.id)).not.toContain(sent.id);
    expect((await drizzle.listPending()).map((n) => n.id)).not.toContain(sent.id);
  });

  it("B5: FAILED is excluded", async () => {
    const { memory, drizzle, failed } = await buildBoundedFixture(2);
    expect((await memory.listPending()).map((n) => n.id)).not.toContain(failed.id);
    expect((await drizzle.listPending()).map((n) => n.id)).not.toContain(failed.id);
  });

  it("B6: next_attempt_at exactly equal to now is eligible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const boundary = new Date("2035-06-01T00:00:00.000Z");
      vi.setSystemTime(boundary);

      const memory = new MemoryNotificationRepository();
      const n = await memory.enqueue(input());
      expect(n.next_attempt_at).toBe(boundary.toISOString());
      expect((await memory.listPending()).map((r) => r.id)).toEqual([n.id]);

      const fake = createFakeDb();
      const drizzle = new DrizzleNotificationRepository(fake.db);
      fake.seed(toRow(n));
      expect((await drizzle.listPending()).map((r) => r.id)).toEqual([n.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B7: rows are ordered by created_at ASC", async () => {
    const { memory, drizzle, due } = await buildBoundedFixture(4);
    const expected = due.map((n) => n.id);
    expect((await memory.listPending()).map((n) => n.id)).toEqual(expected);
    expect((await drizzle.listPending()).map((n) => n.id)).toEqual(expected);
  });

  it("B8: equal created_at falls back to id ASC tie-break", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2035-06-01T00:00:00.000Z"));
      const memory = new MemoryNotificationRepository();
      const created: NotificationDTO[] = [];
      for (let i = 0; i < 5; i += 1) created.push(await memory.enqueue(input()));
      const expected = created.map((n) => n.id).sort((a, b) => a.localeCompare(b));
      expect(new Set(created.map((n) => n.created_at)).size).toBe(1);

      expect((await memory.listPending()).map((n) => n.id)).toEqual(expected);

      const fake = createFakeDb();
      const drizzle = new DrizzleNotificationRepository(fake.db);
      for (const dto of created) fake.seed(toRow(dto));
      expect((await drizzle.listPending()).map((n) => n.id)).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B9: default limit is 50", async () => {
    const { memory, drizzle, due } = await buildBoundedFixture(55);
    const expected = due.map((n) => n.id).slice(0, 50);
    expect((await memory.listPending()).map((n) => n.id)).toEqual(expected);
    expect((await drizzle.listPending()).map((n) => n.id)).toEqual(expected);
  });

  it("B10: explicit limit truncates the exact ordered prefix", async () => {
    const { memory, drizzle, due } = await buildBoundedFixture(6);
    const expected = due.map((n) => n.id).slice(0, 3);
    expect((await memory.listPending(3)).map((n) => n.id)).toEqual(expected);
    expect((await drizzle.listPending(3)).map((n) => n.id)).toEqual(expected);
  });

  it("B11: limit greater than the eligible population returns all eligible rows", async () => {
    const { memory, drizzle, due } = await buildBoundedFixture(4);
    const expected = due.map((n) => n.id);
    expect((await memory.listPending(99)).map((n) => n.id)).toEqual(expected);
    expect((await drizzle.listPending(99)).map((n) => n.id)).toEqual(expected);
  });

  it("B12: Memory and Drizzle results match on identical rows", async () => {
    const { memory, drizzle } = await buildBoundedFixture(7);
    expect(await drizzle.listPending(4)).toEqual(await memory.listPending(4));
    expect(await drizzle.listPending()).toEqual(await memory.listPending());
  });

  it("B13-B16: Drizzle read chains DB-side where/orderBy/limit", async () => {
    const { fake, drizzle } = await buildBoundedFixture(5);
    expect(fake.rowQueries()).toHaveLength(0);

    await drizzle.listPending(3);
    const trace = lastRowQuery(fake);

    const pairs = parsePairs(trace.where);
    expect(pairs.some((p) => p.col === "status" && p.op === "=" && p.val === "PENDING")).toBe(true);
    const duePair = pairs.find((p) => p.col === "next_attempt_at");
    expect(duePair?.op).toBe("<=");
    expect(duePair?.val).toBeInstanceOf(Date);

    expect(trace.orderBy.map((e) => parseOrder(e).col)).toEqual(["created_at", "id"]);
    expect(trace.orderBy.map((e) => parseOrder(e).dir)).toEqual(["asc", "asc"]);
    expect(trace.limit).toBe(3);
  });

  it("B17: the full eligible set is never materialized before the DB limit", async () => {
    const { fake, drizzle } = await buildBoundedFixture(5);
    const result = await drizzle.listPending(2);
    const trace = lastRowQuery(fake);
    expect(result).toHaveLength(2);
    expect(trace.limit).toBe(2);
    expect(trace.emitted).toBe(2);
    // The fake "database" holds the whole eligible set; only `limit` rows cross
    // into application memory because the repository requests the DB limit.
    expect(fake.rows()).toHaveLength(8);
  });

  it("B18: listAll and operability read models remain unchanged", async () => {
    const { memory, fake, drizzle, due } = await buildBoundedFixture(3);
    expect((await memory.listAll()).length).toBe(due.length + 3);
    expect((await drizzle.listAll()).length).toBe(due.length + 3);
    expect(await drizzle.getOperabilityMetrics(READ_NOW)).toEqual(
      await memory.getOperabilityMetrics(READ_NOW),
    );
    expect(await drizzle.getOperabilityHealth(READ_NOW)).toEqual(
      await memory.getOperabilityHealth(READ_NOW),
    );
    expect(fake.setCalls()).toHaveLength(0);
  });
});
