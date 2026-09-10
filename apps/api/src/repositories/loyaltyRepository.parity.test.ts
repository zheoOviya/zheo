import { describe, expect, it, beforeEach } from "vitest";
import {
  loyalty_ledger,
  loyalty_referral_codes,
  loyalty_referrals,
  loyalty_stamp_cards,
  loyalty_streaks,
  loyalty_wallets,
} from "@snakzap/db";
import type { DrizzleDb } from "../lib/dbType";
import {
  MAX_REFERRAL_CODE_ATTEMPTS,
  deriveReferralCode,
  MemoryLoyaltyRepository,
  type LoyaltyRepository,
} from "./loyaltyRepository";
import { DrizzleLoyaltyRepository } from "./drizzle/drizzleLoyaltyRepository";

// ============================================
// Loyalty repository parity tests.
//
// Proves MemoryLoyaltyRepository and DrizzleLoyaltyRepository expose the
// SAME observable behavior for the full LoyaltyRepository contract
// (referral codes/claims, wallet + ledger, streak, stamp cards).
//
// The Drizzle half runs against a lightweight in-memory DrizzleDb stand-in
// that additionally enforces the loyalty PK/UNIQUE constraints and throws
// Postgres-shaped 23505 errors, so the real repository error-translation
// branches are exercised without a live Postgres. Real-Postgres durability
// is proven separately by apps/api/integration/realPgLoyaltyPersistence.ts.
// ============================================

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const USER_C = "00000000-0000-4000-8000-0000000000c3";
const USER_D = "00000000-0000-4000-8000-0000000000d4";
const USER_E = "00000000-0000-4000-8000-0000000000e5";
const USER_F = "00000000-0000-4000-8000-0000000000f6";
const CLAIMANT = "00000000-0000-4000-8000-000000000010";
const RESTAURANT = "00000000-0000-4000-8000-0000000000d0";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================
// In-memory stand-in for the DrizzleDb facade. Parses eq()/and() conditions
// built by drizzle-orm, supports .for("update"), transactions, and the
// loyalty PK/UNIQUE constraints (throwing { code: "23505", constraint }).
// ============================================

interface FakeDb {
  db: DrizzleDb;
  rowsFor: (table: unknown) => Record<string, unknown>[];
}

function uniqueViolation(constraint: string): never {
  // Throw the pg error nested under `cause`, exactly like Drizzle's
  // DrizzleQueryError wrapper, so pgErrorDetails' cause traversal is
  // exercised by the automated suite (not just the real-PG harness).
  throw { cause: { code: "23505", constraint } };
}

function createFakeDb(): FakeDb {
  const tables = new Map<unknown, Record<string, unknown>[]>();
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  function collectPairs(cond: unknown, out: Array<{ col: string; val: unknown }>): void {
    if (!cond || typeof cond !== "object") return;
    const chunks = (cond as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return;

    for (const chunk of chunks) {
      const c = chunk as { queryChunks?: unknown[] } | null;
      if (c && typeof c === "object" && Array.isArray(c.queryChunks)) {
        collectPairs(c, out);
      }
    }

    let col: string | undefined;
    let val: unknown;
    let hasParam = false;
    for (const chunk of chunks) {
      const c = chunk as { name?: unknown; value?: unknown; encoder?: unknown } | null;
      if (!c || typeof c !== "object") continue;
      if (typeof c.name === "string" && col === undefined) col = c.name;
      if ("encoder" in c) {
        val = c.value;
        hasParam = true;
      }
    }
    if (col !== undefined && hasParam) out.push({ col, val });
  }

  const predicateFrom = (cond: unknown): ((row: Record<string, unknown>) => boolean) => {
    if (cond == null) return () => true;
    const pairs: Array<{ col: string; val: unknown }> = [];
    collectPairs(cond, pairs);
    return (row) => pairs.every(({ col, val }) => row[col] === val);
  };

  const nonBlank = (v: unknown): boolean => v != null && v !== "";

  function enforceUnique(table: unknown, row: Record<string, unknown>): void {
    const rows = rowsFor(table);
    if (table === loyalty_referral_codes) {
      if (rows.some((r) => r.user_id === row.user_id)) {
        uniqueViolation("loyalty_referral_codes_pkey");
      }
      if (rows.some((r) => r.code === row.code)) {
        uniqueViolation("loyalty_referral_codes_code_uq");
      }
      return;
    }
    if (table === loyalty_referrals) {
      if (rows.some((r) => r.claimant_user_id === row.claimant_user_id)) {
        uniqueViolation("loyalty_referrals_claimant_uq");
      }
      if (nonBlank(row.ip_address) && rows.some((r) => r.ip_address === row.ip_address)) {
        uniqueViolation("loyalty_referrals_ip_uq");
      }
      if (
        nonBlank(row.device_fingerprint) &&
        rows.some((r) => r.device_fingerprint === row.device_fingerprint)
      ) {
        uniqueViolation("loyalty_referrals_device_uq");
      }
      return;
    }
    if (table === loyalty_wallets) {
      if (rows.some((r) => r.user_id === row.user_id)) {
        uniqueViolation("loyalty_wallets_pkey");
      }
      return;
    }
    if (table === loyalty_streaks) {
      if (rows.some((r) => r.user_id === row.user_id)) {
        uniqueViolation("loyalty_streaks_pkey");
      }
      return;
    }
    if (table === loyalty_stamp_cards) {
      if (
        rows.some(
          (r) => r.user_id === row.user_id && r.restaurant_id === row.restaurant_id,
        )
      ) {
        uniqueViolation("loyalty_stamp_cards_user_id_restaurant_id_pk");
      }
      return;
    }
  }

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond?: unknown) => {
          const exec = () => rowsFor(table).filter(predicateFrom(cond));
          const p = Promise.resolve().then(exec) as Promise<Record<string, unknown>[]> & {
            for: (lock: "update") => Promise<Record<string, unknown>[]>;
          };
          p.for = () => Promise.resolve().then(exec);
          return p;
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        const row = { created_at: new Date(), ...values };
        enforceUnique(table, row);
        rowsFor(table).push(row);
        return [row];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (cond?: unknown) => {
          const pred = predicateFrom(cond);
          const matched = rowsFor(table).filter(pred);
          matched.forEach((r) => Object.assign(r, values));
          return matched;
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

  return { db: db as unknown as DrizzleDb, rowsFor };
}

// ============================================
// Shared semantic scenario run against BOTH repositories.
// ============================================

async function assertSharedSemantics(repo: LoyaltyRepository): Promise<void> {
  // --- referral code: deterministic + stable -----------------------------
  const codeA = await repo.getReferralCode(USER_A);
  expect(codeA).toMatch(/^SNKZ-[A-Z0-9]{1,6}$/);
  expect(await repo.getReferralCode(USER_A)).toBe(codeA);
  expect(await repo.getReferralCode(USER_B)).not.toBe(codeA);

  // --- code -> referrer, with trimming + case folding --------------------
  expect(await repo.getReferrerByCode(codeA)).toBe(USER_A);
  expect(await repo.getReferrerByCode(`  ${codeA.toLowerCase()}  `)).toBe(USER_A);
  expect(await repo.getReferrerByCode("SNKZ-NOPE")).toBeNull();

  // --- claims ------------------------------------------------------------
  expect(await repo.hasUserClaimed(CLAIMANT)).toBe(false);
  expect(await repo.hasClaimedByIp("1.2.3.4")).toBe(false);
  expect(await repo.hasClaimedByDevice("DEV-1")).toBe(false);

  const claim = await repo.recordClaim({
    claimant_user_id: CLAIMANT,
    referrer_user_id: USER_A,
    referral_code: codeA,
    bonus_amount: 50,
    ip_address: "1.2.3.4",
    device_fingerprint: "DEV-1",
  });
  expect(claim.id).toBeTruthy();
  expect(claim.claimant_user_id).toBe(CLAIMANT);
  expect(claim.referrer_user_id).toBe(USER_A);
  expect(claim.referral_code).toBe(codeA);
  expect(claim.bonus_amount).toBe(50);
  expect(claim.ip_address).toBe("1.2.3.4");
  expect(claim.device_fingerprint).toBe("DEV-1");
  expect(Number.isNaN(Date.parse(claim.created_at))).toBe(false);

  expect(await repo.hasUserClaimed(CLAIMANT)).toBe(true);
  expect(await repo.hasClaimedByIp("1.2.3.4")).toBe(true);
  expect(await repo.hasClaimedByDevice("DEV-1")).toBe(true);
  expect(await repo.hasClaimedByIp("")).toBe(false);
  expect(await repo.hasClaimedByDevice("")).toBe(false);
  expect(await repo.hasClaimedByIp("9.9.9.9")).toBe(false);

  expect((await repo.getReferralClaimsByReferrer(USER_A)).map((c) => c.id)).toEqual([
    claim.id,
  ]);
  expect((await repo.getReferralClaimsByClaimant(CLAIMANT)).map((c) => c.id)).toEqual([
    claim.id,
  ]);
  expect(await repo.getReferralClaimsByReferrer(USER_B)).toEqual([]);

  // --- wallet + ledger ---------------------------------------------------
  expect(await repo.getWallet(USER_C)).toEqual({
    user_id: USER_C,
    balance: 0,
    total_earned: 0,
  });

  const w1 = await repo.creditWallet(USER_C, 50, "referral_bonus");
  expect(w1).toEqual({ user_id: USER_C, balance: 50, total_earned: 50 });
  await sleep(2);
  const w2 = await repo.creditWallet(USER_C, 0.5, "pickup_cashback");
  expect(w2).toEqual({ user_id: USER_C, balance: 50.5, total_earned: 50.5 });
  expect(await repo.getWallet(USER_C)).toEqual(w2);

  const txns = await repo.getWalletTransactions(USER_C);
  expect(txns).toHaveLength(2);
  expect(txns.map((t) => t.reason)).toEqual(["pickup_cashback", "referral_bonus"]);
  expect(txns.map((t) => t.amount)).toEqual([0.5, 50]);
  expect(txns.map((t) => t.balance_after)).toEqual([50.5, 50]);
  expect(txns.every((t) => !Number.isNaN(Date.parse(t.created_at)))).toBe(true);
  expect(await repo.getWalletTransactions(USER_D)).toEqual([]);

  // --- streak ------------------------------------------------------------
  expect(await repo.getStreak(USER_D)).toEqual({
    user_id: USER_D,
    current_streak: 0,
    best_streak: 0,
    last_pickup_day: null,
    updated_at: expect.any(String),
  });

  const p1 = await repo.recordPickup(USER_D, "2026-09-01");
  expect(p1.streak.current_streak).toBe(1);
  expect(p1.streak.best_streak).toBe(1);
  expect(p1.streak.last_pickup_day).toBe("2026-09-01");
  expect(p1.advanced).toBe(true);
  expect(p1.badge_unlocked).toBe(false);

  const p1again = await repo.recordPickup(USER_D, "2026-09-01");
  expect(p1again.advanced).toBe(false);
  expect(p1again.badge_unlocked).toBe(false);
  expect(p1again.streak.current_streak).toBe(1);

  const p2 = await repo.recordPickup(USER_D, "2026-09-02");
  expect(p2.streak.current_streak).toBe(2);
  expect(p2.advanced).toBe(true);

  const gap = await repo.recordPickup(USER_D, "2026-09-05");
  expect(gap.streak.current_streak).toBe(1);
  expect(gap.streak.best_streak).toBe(2);
  const persisted = await repo.getStreak(USER_D);
  expect(persisted.current_streak).toBe(1);
  expect(persisted.best_streak).toBe(2);
  expect(persisted.last_pickup_day).toBe("2026-09-05");

  // 7 consecutive days -> badge unlocked on the 7th.
  let seventh = await repo.recordPickup(USER_F, "2026-10-01");
  for (let i = 2; i <= 7; i += 1) {
    const day = `2026-10-${String(i).padStart(2, "0")}`;
    seventh = await repo.recordPickup(USER_F, day);
  }
  expect(seventh.streak.current_streak).toBe(7);
  expect(seventh.badge_unlocked).toBe(true);

  // --- stamp cards -------------------------------------------------------
  expect(await repo.getStampCard(USER_E, RESTAURANT)).toBeNull();
  for (let i = 1; i <= 9; i += 1) {
    const res = await repo.incrementStamp(USER_E, RESTAURANT);
    expect(res.card.stamp_count).toBe(i);
    expect(res.card.total_orders).toBe(i);
    expect(res.card.rewards_earned).toBe(0);
    expect(res.card.reward_type).toBe("FREE_ITEM");
    expect(res.reward_unlocked).toBe(false);
  }
  const tenth = await repo.incrementStamp(USER_E, RESTAURANT);
  expect(tenth.reward_unlocked).toBe(true);
  expect(tenth.card.stamp_count).toBe(0);
  expect(tenth.card.total_orders).toBe(10);
  expect(tenth.card.rewards_earned).toBe(1);

  const card = await repo.getStampCard(USER_E, RESTAURANT);
  expect(card).not.toBeNull();
  expect(card!.stamp_count).toBe(0);
  expect(card!.total_orders).toBe(10);
  expect(card!.rewards_earned).toBe(1);

  const cards = await repo.getStampCards(USER_E);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.restaurant_id).toBe(RESTAURANT);
  expect(await repo.getStampCards(USER_A)).toEqual([]);
}

// ============================================
// Memory repository is the reference semantics.
// ============================================

describe("MemoryLoyaltyRepository semantics", () => {
  let repo: MemoryLoyaltyRepository;

  beforeEach(() => {
    repo = new MemoryLoyaltyRepository();
  });

  it("matches the full shared semantic contract", async () => {
    await assertSharedSemantics(repo);
  });

  it("exhausts deterministic attempts and throws a bounded AppError", async () => {
    const userId = USER_A;
    const internal = repo as unknown as {
      codeOwners: Map<string, string>;
    };
    for (let attempt = 0; attempt < MAX_REFERRAL_CODE_ATTEMPTS; attempt += 1) {
      internal.codeOwners.set(deriveReferralCode(userId, attempt), USER_B);
    }
    let caught: { code?: string; status?: number } | null = null;
    try {
      await repo.getReferralCode(userId);
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("REFERRAL_CODE_GENERATION_FAILED");
    expect(caught!.status).toBe(500);
  });

  it("never shares or overwrites another user's referral code", async () => {
    const claimed = await repo.getReferralCode(USER_A);
    const other = await repo.getReferralCode(USER_B);
    expect(other).not.toBe(claimed);
    expect(await repo.getReferrerByCode(claimed)).toBe(USER_A);
    expect(await repo.getReferrerByCode(other)).toBe(USER_B);
  });
});

// ============================================
// Drizzle repository exposes identical behavior through the SQL facade.
// ============================================

describe("DrizzleLoyaltyRepository (Postgres-mode facade) semantics", () => {
  let fake: FakeDb;
  let repo: DrizzleLoyaltyRepository;

  beforeEach(() => {
    fake = createFakeDb();
    repo = new DrizzleLoyaltyRepository(fake.db);
  });

  it("matches the full shared semantic contract", async () => {
    await assertSharedSemantics(repo);
  });

  it("derives the same code bytes as Memory for every user", async () => {
    const memory = new MemoryLoyaltyRepository();
    for (const user of [USER_A, USER_B, USER_C, USER_D]) {
      expect(await repo.getReferralCode(user)).toBe(await memory.getReferralCode(user));
    }
  });

  it("bounded-exhausts deterministic attempts with the same AppError as Memory", async () => {
    const rows = fake.rowsFor(loyalty_referral_codes);
    for (let attempt = 0; attempt < MAX_REFERRAL_CODE_ATTEMPTS; attempt += 1) {
      rows.push({
        user_id: `00000000-0000-4000-8000-${(0x100 + attempt)
          .toString(16)
          .padStart(12, "0")}`,
        code: deriveReferralCode(USER_A, attempt),
        created_at: new Date(),
      });
    }
    let caught: { code?: string; status?: number } | null = null;
    try {
      await repo.getReferralCode(USER_A);
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("REFERRAL_CODE_GENERATION_FAILED");
    expect(caught!.status).toBe(500);
  });

  it("advances to the next deterministic attempt on a cross-user code collision", async () => {
    fake.rowsFor(loyalty_referral_codes).push({
      user_id: USER_B,
      code: deriveReferralCode(USER_A, 0),
      created_at: new Date(),
    });
    const code = await repo.getReferralCode(USER_A);
    expect(code).toBe(deriveReferralCode(USER_A, 1));
    expect(await repo.getReferrerByCode(deriveReferralCode(USER_A, 0))).toBe(USER_B);
    expect(await repo.getReferrerByCode(code)).toBe(USER_A);
  });

  it("translates a duplicate claimant into REFERRAL_ALREADY_USED/400", async () => {
    await repo.recordClaim({
      claimant_user_id: CLAIMANT,
      referrer_user_id: USER_A,
      referral_code: "SNKZ-AAA",
      bonus_amount: 50,
      ip_address: null,
      device_fingerprint: null,
    });
    let caught: { code?: string; status?: number } | null = null;
    try {
      await repo.recordClaim({
        claimant_user_id: CLAIMANT,
        referrer_user_id: USER_B,
        referral_code: "SNKZ-BBB",
        bonus_amount: 50,
        ip_address: null,
        device_fingerprint: null,
      });
    } catch (err) {
      caught = err as { code?: string; status?: number };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("REFERRAL_ALREADY_USED");
    expect(caught!.status).toBe(400);
  });

  it("translates duplicate ip/device into FRAUD_DETECTED/403", async () => {
    await repo.recordClaim({
      claimant_user_id: CLAIMANT,
      referrer_user_id: USER_A,
      referral_code: "SNKZ-AAA",
      bonus_amount: 50,
      ip_address: "5.5.5.5",
      device_fingerprint: "DEV-X",
    });
    const other = "00000000-0000-4000-8000-000000000011";

    const ipErr = await repo
      .recordClaim({
        claimant_user_id: other,
        referrer_user_id: USER_A,
        referral_code: "SNKZ-AAA",
        bonus_amount: 50,
        ip_address: "5.5.5.5",
        device_fingerprint: "DEV-Y",
      })
      .then(() => null)
      .catch((err: { code?: string; status?: number }) => err);
    expect(ipErr!.code).toBe("FRAUD_DETECTED");
    expect(ipErr!.status).toBe(403);

    const deviceErr = await repo
      .recordClaim({
        claimant_user_id: other,
        referrer_user_id: USER_A,
        referral_code: "SNKZ-AAA",
        bonus_amount: 50,
        ip_address: "6.6.6.6",
        device_fingerprint: "DEV-X",
      })
      .then(() => null)
      .catch((err: { code?: string; status?: number }) => err);
    expect(deviceErr!.code).toBe("FRAUD_DETECTED");
    expect(deviceErr!.status).toBe(403);
  });

  it("keeps blank ip/device out of the partial uniques", async () => {
    for (const [claimant, ip, device] of [
      ["00000000-0000-4000-8000-000000000021", "", ""],
      ["00000000-0000-4000-8000-000000000022", "", ""],
      ["00000000-0000-4000-8000-000000000023", null, null],
    ] as const) {
      const claim = await repo.recordClaim({
        claimant_user_id: claimant,
        referrer_user_id: USER_A,
        referral_code: "SNKZ-AAA",
        bonus_amount: 50,
        ip_address: ip,
        device_fingerprint: device,
      });
      expect(claim.ip_address).toBe(ip === "" ? "" : null);
    }
    expect(fake.rowsFor(loyalty_referrals)).toHaveLength(3);
  });

  it("writes decimal columns as strings and reads them back as numbers", async () => {
    await repo.creditWallet(USER_C, 12.34, "referral_bonus");
    const row = fake.rowsFor(loyalty_wallets)[0]!;
    expect(row.balance).toBe("12.34");
    expect(row.total_earned).toBe("12.34");
    const txRow = fake.rowsFor(loyalty_ledger)[0]!;
    expect(txRow.amount).toBe("12.34");
    expect(txRow.balance_after).toBe("12.34");
    expect((await repo.getWallet(USER_C)).balance).toBe(12.34);
  });
});

// ============================================
// Cross-store parity: identical seeds produce identical observable results.
// ============================================

describe("Loyalty repository Memory <-> Drizzle parity", () => {
  it("produces identical codes, wallets, ledger, streaks and stamp cards", async () => {
    const memory = new MemoryLoyaltyRepository();
    const fake = createFakeDb();
    const drizzle = new DrizzleLoyaltyRepository(fake.db);

    for (const user of [USER_A, USER_B, USER_C, USER_D, USER_E]) {
      expect(await drizzle.getReferralCode(user)).toBe(await memory.getReferralCode(user));
    }

    await memory.creditWallet(USER_C, 50, "referral_bonus");
    await drizzle.creditWallet(USER_C, 50, "referral_bonus");
    await sleep(2);
    await memory.creditWallet(USER_C, 0.25, "pickup_cashback");
    await drizzle.creditWallet(USER_C, 0.25, "pickup_cashback");
    expect(await drizzle.getWallet(USER_C)).toEqual(await memory.getWallet(USER_C));
    expect((await drizzle.getWalletTransactions(USER_C)).map((t) => t.amount)).toEqual(
      (await memory.getWalletTransactions(USER_C)).map((t) => t.amount),
    );

    for (const day of ["2026-08-01", "2026-08-02", "2026-08-05", "2026-08-05"]) {
      const mem = await memory.recordPickup(USER_D, day);
      const driz = await drizzle.recordPickup(USER_D, day);
      expect(driz.advanced).toBe(mem.advanced);
      expect(driz.badge_unlocked).toBe(mem.badge_unlocked);
      expect(driz.streak.current_streak).toBe(mem.streak.current_streak);
      expect(driz.streak.best_streak).toBe(mem.streak.best_streak);
      expect(driz.streak.last_pickup_day).toBe(mem.streak.last_pickup_day);
    }

    for (let i = 0; i < 11; i += 1) {
      const mem = await memory.incrementStamp(USER_E, RESTAURANT);
      const driz = await drizzle.incrementStamp(USER_E, RESTAURANT);
      expect(driz.reward_unlocked).toBe(mem.reward_unlocked);
      expect(driz.card.stamp_count).toBe(mem.card.stamp_count);
      expect(driz.card.total_orders).toBe(mem.card.total_orders);
      expect(driz.card.rewards_earned).toBe(mem.card.rewards_earned);
    }
  });
});
