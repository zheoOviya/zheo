import { describe, expect, it } from "vitest";
import type { DrizzleDb, SelectQuery } from "../lib/dbType";
import {
  DrizzleNotificationRepository,
  MemoryNotificationRepository,
  type NotificationDTO,
  type NotificationRepository,
} from "./notificationRepository";

// ============================================================
// NOTIFICATION-PG-PARITY-A2 — memory/Postgres observable parity for
// `attempts`. The Drizzle backend must apply the SAME attempt semantics as
// the authoritative memory backend (attempts+1 on every terminal/retry
// transition), and must do so with an atomic SQL increment rather than a
// read-modify-write in application code.
//
// The in-memory stand-in below interprets the two Postgres conditions the
// repository builds (eq(status) + lte(next_attempt_at)) and the atomic
// `attempts = attempts + 1` SQL expression produced by drizzle-orm, so these
// tests exercise the real DrizzleNotificationRepository code path without a
// live connection. Durable semantics are additionally proven against real
// PostgreSQL by apps/api/integration/realPgNotificationParity.ts.
// ============================================================

interface FakeDb {
  db: DrizzleDb;
  rows: () => Record<string, unknown>[];
  setCalls: () => Array<Record<string, unknown>>;
}

interface Pair {
  col: string;
  op: "=" | "<=";
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
    let op: "=" | "<=" = "=";
    while (j < tokens.length && tokens[j]!.kind !== "param" && tokens[j]!.kind !== "col") {
      const text = tokens[j]!.text;
      if (typeof text === "string") {
        if (text.includes("<=")) op = "<=";
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

function predicate(cond: unknown): (row: Record<string, unknown>) => boolean {
  const pairs = parsePairs(cond);
  return (row) =>
    pairs.every(({ col, op, val }) => {
      if (op === "<=") {
        const left = (row[col] as Date).getTime();
        const right = (val as Date).getTime();
        return left <= right;
      }
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
            for (const row of rows) {
              if (pred(row)) applySet(row, values);
            }
            return Promise.resolve([]);
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

describe("MemoryNotificationRepository attempts semantics (authoritative)", () => {
  it("enqueue starts PENDING with attempts 0 and no error", async () => {
    const repo = new MemoryNotificationRepository();
    const n = await repo.enqueue(input());
    expect(n.status).toBe("PENDING");
    expect(n.attempts).toBe(0);
    expect(n.last_error).toBeNull();
  });

  it("markSent increments attempts and clears last_error", async () => {
    const repo = new MemoryNotificationRepository();
    const n = await repo.enqueue(input());
    await repo.markSent(n.id);
    const [row] = await repo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBeNull();
  });

  it("markRetryable increments attempts, keeps PENDING, records error + backoff", async () => {
    const repo = new MemoryNotificationRepository();
    const n = await repo.enqueue(input());
    await repo.markRetryable(n.id, "boom", FUTURE);
    const [row] = await repo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("boom");
    expect(row!.next_attempt_at).toBe(FUTURE.toISOString());
  });

  it("markDead increments attempts and records FAILED", async () => {
    const repo = new MemoryNotificationRepository();
    const n = await repo.enqueue(input());
    await repo.markDead(n.id, "dead");
    const [row] = await repo.listAll();
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("dead");
  });
});

describe("DrizzleNotificationRepository attempts parity", () => {
  it("enqueue returns PENDING/attempts 0 and persists the same", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    expect(n.status).toBe("PENDING");
    expect(n.attempts).toBe(0);
    const [row] = await repo.listAll();
    expect(row!.attempts).toBe(0);
    expect(row!.status).toBe("PENDING");
    expect(row!.last_error).toBeNull();
  });

  it("markSent applies attempts+1, SENT, last_error=null", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markSent(n.id);
    const [row] = await repo.listAll();
    expect(row!.status).toBe("SENT");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBeNull();
  });

  it("consecutive markSent calls accumulate attempts (1 then 2)", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markSent(n.id);
    await repo.markSent(n.id);
    const [row] = await repo.listAll();
    expect(row!.attempts).toBe(2);
  });

  it("markRetryable applies attempts+1, keeps PENDING, records error + backoff", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markRetryable(n.id, "boom", FUTURE);
    const [row] = await repo.listAll();
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("boom");
    expect(row!.next_attempt_at).toBe(FUTURE.toISOString());
  });

  it("markDead applies attempts+1 and records FAILED", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markDead(n.id, "dead");
    const [row] = await repo.listAll();
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("dead");
  });

  it("mixed transitions accumulate attempts across retry then death", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markRetryable(n.id, "e1", PAST);
    await repo.markRetryable(n.id, "e2", PAST);
    await repo.markDead(n.id, "e3");
    const [row] = await repo.listAll();
    expect(row!.attempts).toBe(3);
    expect(row!.status).toBe("FAILED");
    expect(row!.last_error).toBe("e3");
  });

  it("uses an atomic SQL increment expression, not an absolute app-computed value", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const n = await repo.enqueue(input());
    await repo.markSent(n.id);
    const sent = fake.setCalls().find((c) => c.status === "SENT");
    expect(sent).toBeDefined();
    expect(typeof sent!.attempts).not.toBe("number");
    expect(sent!.attempts).toBeTruthy();
    expect(
      Array.isArray((sent!.attempts as { queryChunks?: unknown[] }).queryChunks),
    ).toBe(true);

    await repo.markRetryable(n.id, "boom", FUTURE);
    const retry = fake.setCalls().filter((c) => c.status === "PENDING").at(-1);
    expect(typeof retry!.attempts).not.toBe("number");

    await repo.markDead(n.id, "dead");
    const dead = fake.setCalls().find((c) => c.status === "FAILED");
    expect(typeof dead!.attempts).not.toBe("number");
  });

  it("listPending filters PENDING + due, excluding SENT/FAILED and future backoff", async () => {
    const fake = createFakeDb();
    const repo = new DrizzleNotificationRepository(fake.db);
    const due = await repo.enqueue(input());
    const backedOff = await repo.enqueue(input());
    const sent = await repo.enqueue(input());
    const failed = await repo.enqueue(input());
    await repo.markRetryable(backedOff.id, "later", FUTURE);
    await repo.markSent(sent.id);
    await repo.markDead(failed.id, "dead");

    const pending = await repo.listPending();
    const ids = pending.map((p) => p.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(backedOff.id);
    expect(ids).not.toContain(sent.id);
    expect(ids).not.toContain(failed.id);
  });
});

describe("Memory/Postgres transition parity", () => {
  it("identical operation sequence yields identical observable state", async () => {
    const memory = new MemoryNotificationRepository();
    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);

    const run = async (repo: NotificationRepository) => {
      const n = await repo.enqueue(input());
      await repo.markRetryable(n.id, "e1", PAST);
      await repo.markRetryable(n.id, "e2", PAST);
      await repo.markDead(n.id, "e3");
      const afterDead = await snapshot(repo);
      expect(afterDead[0]!.attempts).toBe(3);
      expect(afterDead[0]!.status).toBe("FAILED");
      expect(afterDead[0]!.last_error).toBe("e3");
      return afterDead.map((r) => ({
        status: r.status,
        attempts: r.attempts,
        last_error: r.last_error,
      }));
    };

    const memoryState = await run(memory);
    const drizzleState = await run(drizzle);
    expect(drizzleState).toEqual(memoryState);
  });

  it("mark on an unknown id is a silent no-op in both backends", async () => {
    const memory = new MemoryNotificationRepository();
    const fake = createFakeDb();
    const drizzle = new DrizzleNotificationRepository(fake.db);
    await memory.markSent("00000000-0000-4000-8000-0000000000ff");
    await drizzle.markSent("00000000-0000-4000-8000-0000000000ff");
    expect(await memory.listAll()).toHaveLength(0);
    expect(await drizzle.listAll()).toHaveLength(0);
  });
});
