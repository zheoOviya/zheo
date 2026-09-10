// ============================================================
// LOYALTY-PG-DURABILITY-A2 — REAL-POSTGRES DURABILITY PROOF (INTEGRATION ONLY).
//
// NOT part of the memory-mode unit suite. Run explicitly under a non-test
// NODE_ENV against a disposable, already-migrated DATABASE_URL (migration
// 0015_loyalty_persistence.sql must have been applied):
//
//   NODE_ENV=development \
//   DATABASE_URL=postgresql://a2_support_proof:<pw>@127.0.0.1:5432/a2_support_proof \
//   pnpm exec tsx apps/api/integration/realPgLoyaltyPersistence.ts
//
// PROVES (and only claims):
//   (1) referral code / claim / wallet / ledger / streak / stamp-card writes
//       are readable through independent connections.
//   (2) every value survives closing the pool and rebuilding the repository
//       over a fresh connection (durability across restart, 3 epochs).
//   (3) concurrent wallet credits to one user all apply exactly once
//       (transaction + SELECT ... FOR UPDATE serialization).
//   (4) concurrent stamp increments to one card all apply exactly once.
//   (5) a same-user concurrent referral-code race converges on one code.
//   (6) a genuine cross-user code collision advances one user deterministically
//       to the next attempt instead of colliding or overwriting.
//
// Memory-parity alone is not a durability proof; this harness talks to the
// real tables. Disposable rows are left in the disposable DB by design.
// ============================================================

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DrizzleLoyaltyRepository } from "../src/repositories/drizzle/drizzleLoyaltyRepository";
import { deriveReferralCode } from "../src/repositories/loyaltyRepository";
import type { DrizzleDb } from "../src/lib/dbType";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FATAL: DATABASE_URL is required (must point at a disposable, migrated DB)");
  process.exit(2);
}
if (process.env.NODE_ENV === "test") {
  console.error("FATAL: must run under a non-test NODE_ENV (createDb() rejects test mode)");
  process.exit(2);
}
const dbUrl: string = url;

function redacted(u: string): string {
  try {
    const p = new URL(u);
    p.password = "***";
    return p.toString();
  } catch {
    return "(unparseable)";
  }
}

function makeDb(pool: Pool): DrizzleDb {
  return drizzle(pool) as unknown as DrizzleDb;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** Search randomly generated UUID-shaped ids for two whose attempt-0 referral
 *  code is identical, so the cross-user collision path can be proven on the
 *  real UNIQUE(code) index (a natural collision, found ~39k draws). */
function findCollidingPair(): [string, string] {
  const seen = new Map<string, string>();
  for (let i = 0; i < 2_000_000; i += 1) {
    const id = randomUUID();
    const code = deriveReferralCode(id, 0);
    const prior = seen.get(code);
    if (prior !== undefined && prior !== id) return [prior, id];
    seen.set(code, id);
  }
  throw new Error("could not find a colliding referral-code pair");
}

async function main(): Promise<void> {
  console.log(`DATABASE_URL target (redacted): ${redacted(dbUrl)}`);
  console.log("A2 real-PG loyalty persistence proof starting...");

  // ---------- Connection epoch 1: write ----------
  const referrer = randomUUID();
  const claimCode = deriveReferralCode(referrer, 0);
  const claimant = randomUUID();
  const restaurant = randomUUID();
  const streakUser = referrer;
  const runTag = randomUUID().slice(0, 8);

  const poolA = new Pool({ connectionString: dbUrl, max: 2 });
  const repoA = new DrizzleLoyaltyRepository(makeDb(poolA));
  try {
    const code = await repoA.getReferralCode(referrer);
    assert(code === claimCode, `epoch1: unexpected code ${code} != ${claimCode}`);
    console.log(`[epoch1] getReferralCode -> ${code}`);

    const claim = await repoA.recordClaim({
      claimant_user_id: claimant,
      referrer_user_id: referrer,
      referral_code: code,
      bonus_amount: 50,
      ip_address: `a2-ip-${runTag}`,
      device_fingerprint: `a2-dev-${runTag}`,
    });
    assert(claim.id, "epoch1: claim missing id");
    assert(claim.bonus_amount === 50, "epoch1: claim bonus not 50");
    assert(!Number.isNaN(Date.parse(claim.created_at)), "epoch1: claim created_at invalid");

    const w1 = await repoA.creditWallet(referrer, 50, "referral_bonus");
    const w2 = await repoA.creditWallet(referrer, 0.5, "pickup_cashback");
    assert(w1.balance === 50, "epoch1: wallet after bonus not 50");
    assert(close(w2.balance, 50.5), `epoch1: wallet balance not 50.5 (${w2.balance})`);
    assert(w2.total_earned === 50.5, "epoch1: wallet total_earned not 50.5");

    const s1 = await repoA.recordPickup(streakUser, "2026-09-01");
    const s2 = await repoA.recordPickup(streakUser, "2026-09-02");
    assert(s1.streak.current_streak === 1, "epoch1: streak day1 not 1");
    assert(s2.streak.current_streak === 2, "epoch1: streak day2 not 2");

    const st = await repoA.incrementStamp(referrer, restaurant);
    assert(st.card.stamp_count === 1 && st.card.total_orders === 1, "epoch1: stamp not 1");
    console.log(
      `[epoch1] claim + wallet=${w2.balance} + streak=${s2.streak.current_streak} + stamp=${st.card.stamp_count} OK`,
    );
  } finally {
    await poolA.end();
  }

  // ---------- Connection epoch 2: durability + concurrency ----------
  const poolB = new Pool({ connectionString: dbUrl, max: 6 });
  const repoB = new DrizzleLoyaltyRepository(makeDb(poolB));
  try {
    const persistedClaim = await repoB.getReferralClaimsByReferrer(referrer);
    assert(persistedClaim.length === 1, `epoch2: expected 1 claim, got ${persistedClaim.length}`);
    assert(persistedClaim[0]!.claimant_user_id === claimant, "epoch2: claim claimant mismatch");
    assert(persistedClaim[0]!.bonus_amount === 50, "epoch2: claim bonus not durable");

    const wallet = await repoB.getWallet(referrer);
    assert(close(wallet.balance, 50.5), `epoch2: wallet balance lost (${wallet.balance})`);
    assert(wallet.total_earned === 50.5, "epoch2: wallet total_earned lost");

    const txns = await repoB.getWalletTransactions(referrer);
    assert(txns.length === 2, `epoch2: expected 2 ledger rows, got ${txns.length}`);
    assert(txns[0]!.amount === 0.5, "epoch2: newest ledger amount not durable");

    const streak = await repoB.getStreak(referrer);
    assert(streak.current_streak === 2, `epoch2: streak lost (${streak.current_streak})`);
    assert(streak.last_pickup_day === "2026-09-02", "epoch2: streak day lost");

    const stamp = await repoB.getStampCard(referrer, restaurant);
    assert(stamp !== null, "epoch2: stamp card lost");
    assert(stamp!.total_orders === 1, "epoch2: stamp total_orders lost");
    console.log("[epoch2] all epoch1 state durable across a fresh pool/connection");

    // Concurrent wallet credits: 5 x 1.00 must apply exactly once each.
    const walletUser = randomUUID();
    await Promise.all(
      Array.from({ length: 5 }, () => repoB.creditWallet(walletUser, 1, "pickup_cashback")),
    );
    const concurrentWallet = await repoB.getWallet(walletUser);
    assert(
      close(concurrentWallet.balance, 5),
      `epoch2: concurrent credits not exact (${concurrentWallet.balance})`,
    );
    const concurrentTxns = await repoB.getWalletTransactions(walletUser);
    assert(concurrentTxns.length === 5, `epoch2: expected 5 ledger rows (${concurrentTxns.length})`);
    console.log(`[epoch2] 5 concurrent wallet credits -> exact balance ${concurrentWallet.balance}`);

    // Concurrent stamp increments: 5 must apply exactly once each.
    const stampUser = randomUUID();
    await Promise.all(
      Array.from({ length: 5 }, () => repoB.incrementStamp(stampUser, restaurant)),
    );
    const concurrentStamp = await repoB.getStampCard(stampUser, restaurant);
    assert(concurrentStamp !== null, "epoch2: concurrent stamp card missing");
    assert(
      concurrentStamp!.total_orders === 5 && concurrentStamp!.stamp_count === 5,
      `epoch2: concurrent stamps not exact (orders=${concurrentStamp!.total_orders}, count=${concurrentStamp!.stamp_count})`,
    );
    console.log(
      `[epoch2] 5 concurrent stamp increments -> orders=${concurrentStamp!.total_orders}, count=${concurrentStamp!.stamp_count}`,
    );

    // Same-user concurrent referral-code race: all callers converge on one code.
    const raceUser = randomUUID();
    const raced = await Promise.all(
      Array.from({ length: 8 }, () => repoB.getReferralCode(raceUser)),
    );
    const uniqueRaced = new Set(raced);
    assert(uniqueRaced.size === 1, `epoch2: code race diverged (${[...uniqueRaced].join(",")})`);
    const raceCode = raced[0]!;
    assert(raceCode === deriveReferralCode(raceUser, 0), "epoch2: race code not legacy bytes");
    assert(await repoB.getReferrerByCode(raceCode) === raceUser, "epoch2: race code owner wrong");
    console.log(`[epoch2] 8 concurrent getReferralCode calls converged on ${raceCode}`);

    // Genuine cross-user collision: second user advances to attempt 1.
    const [colliderA, colliderB] = findCollidingPair();
    const codeA = await repoB.getReferralCode(colliderA);
    const codeB = await repoB.getReferralCode(colliderB);
    assert(codeA === deriveReferralCode(colliderA, 0), "epoch2: colliderA code not attempt 0");
    assert(codeB === deriveReferralCode(colliderB, 1), `epoch2: colliderB did not advance (${codeB})`);
    assert(codeA !== codeB, "epoch2: colliding codes were not disambiguated");
    assert(await repoB.getReferrerByCode(codeA) === colliderA, "epoch2: colliderA owner wrong");
    assert(await repoB.getReferrerByCode(codeB) === colliderB, "epoch2: colliderB owner wrong");
    console.log(
      `[epoch2] cross-user collision disambiguated: ${colliderA.slice(-4)}->${codeA}, ${colliderB.slice(-4)}->${codeB}`,
    );
  } finally {
    await poolB.end();
  }

  // ---------- Connection epoch 3: everything survived a second restart ----------
  const poolC = new Pool({ connectionString: dbUrl, max: 2 });
  const repoC = new DrizzleLoyaltyRepository(makeDb(poolC));
  try {
    const walletFinal = await repoC.getWallet(referrer);
    assert(close(walletFinal.balance, 50.5), "epoch3: base wallet lost");
    const txnsFinal = await repoC.getWalletTransactions(referrer);
    assert(txnsFinal.length === 2, "epoch3: base ledger lost");
    const claimsFinal = await repoC.getReferralClaimsByReferrer(referrer);
    assert(claimsFinal.length === 1, "epoch3: claim lost");
    const streakFinal = await repoC.getStreak(referrer);
    assert(streakFinal.current_streak === 2, "epoch3: streak lost");
    const stampFinal = await repoC.getStampCard(referrer, restaurant);
    assert(stampFinal !== null && stampFinal.total_orders === 1, "epoch3: stamp lost");

    const finalCode = await repoC.getReferralCode(referrer);
    assert(finalCode === claimCode, "epoch3: referral code changed across restarts");
    assert(await repoC.getReferrerByCode(finalCode) === referrer, "epoch3: code owner lost");

    console.log("[epoch3] referral code / claim / wallet / ledger / streak / stamp all durable");
  } finally {
    await poolC.end();
  }

  console.log("A2 REAL-PG LOYALTY PERSISTENCE PROOF PASSED");
  console.log(`A2 referrer kept in disposable DB for manual inspection: ${referrer}`);
}

main().catch((err) => {
  console.error("A2 REAL-PG LOYALTY PERSISTENCE FAILED:", err instanceof Error ? err.message : err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exitCode = 1;
});
