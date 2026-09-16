import { describe, expect, it } from "vitest";
import type { DrizzleDb, SelectQuery } from "../lib/dbType";
import {
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
    if (!chunk || typeof chunk !== "object") continue;
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

function predicate(cond: unknown): (row: Record<string, unknown>) => boolean {
  const pairs = parsePairs(cond);
  return (row) =>
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

function createFakeDb(): FakeDb {
  const rows: Record<string, unknown>[] = [];
  const setCalls: Array<Record<string, unknown>> = [];

  const db: DrizzleDb = {
    select: () => ({
      from: () => ({
        where: (cond) => {
          const exec = () => rows.filter(predicate(cond));
          const p = Promise.resolve().then(exec) as unknown as SelectQuery;
          p.for = () => p;
          return p;
        },
      }),
    }),
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
    transaction: async (fn) => fn(db),
    delete: () => ({ where: () => Promise.resolve([]) }),
  };

  return { db, rows: () => rows, setCalls: () => setCalls };
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
      const due = new Date();
      const n = await repo.enqueue(input());
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
      const due = new Date();
      const n = await repo.enqueue(input());
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
    const due = new Date();

    const run = async (repo: NotificationRepository) => {
      const n = await repo.enqueue(input());
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
