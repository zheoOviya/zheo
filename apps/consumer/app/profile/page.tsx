"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import StampCardProgress from "@/components/StampCardProgress";
import { useAuthStore } from "@/lib/store";
import { useTheme } from "@/components/ThemeProvider";
import { useI18n } from "@/lib/i18n";
import {
  applyReferral,
  createSupportTicket,
  fetchReferralProfile,
  fetchRestaurants,
  fetchStampCards,
  fetchStreak,
  fetchVipStatus,
  fetchWallet,
  updateSpiceTolerance,
  type ReferralProfile,
  type Restaurant,
  type StampCard,
  type StreakData,
  type SupportTicketResult,
  type VipStatus,
  type WalletData,
} from "@/lib/api";

const SPICE_LABELS = [
  "Mild",
  "Gently spicy",
  "Balanced",
  "Fiery",
  "Volcano",
] as const;

function FlameIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={filled ? "text-red-500" : "text-neutral-300"}
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function SpiceToleranceCard({
  tolerance,
  onSaved,
}: {
  tolerance: number | null;
  onSaved: (value: number) => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function handleSelect(level: number) {
    if (!accessToken || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateSpiceTolerance(accessToken, level);
      onSaved(level);
      setMessage({
        ok: true,
        text: `Spice preference set to ${SPICE_LABELS[level - 1]}.`,
      });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const active = tolerance ?? 0;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary-700 dark:text-primary-300">Spice Profile</h2>
        <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-600 dark:bg-red-900/30 dark:text-red-400">
          {tolerance ? SPICE_LABELS[tolerance - 1] : "Not set"}
        </span>
      </div>
      <p className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
        Set your heat tolerance (1-5). Menus will automatically hide dishes
        spicier than this level.
      </p>

      <div className="flex items-center justify-center gap-2">
        {SPICE_LABELS.map((label, i) => {
          const level = i + 1;
          const filled = active >= level;
          return (
            <button
              key={label}
              type="button"
              aria-label={`Spice level ${level}: ${label}`}
              onClick={() => handleSelect(level)}
              disabled={saving}
              className="flex flex-col items-center gap-1 rounded-xl border border-neutral-100 px-3 py-2 hover:bg-red-50 disabled:opacity-50"
            >
              <FlameIcon filled={filled} />
              <span
                className={`text-[10px] font-medium ${filled ? "text-red-500" : "text-neutral-400"}`}
              >
                {level}
              </span>
            </button>
          );
        })}
      </div>
      {message && (
        <p
          className={`mt-3 text-center text-sm ${message.ok ? "text-green-600" : "text-red-500"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

function WalletRewardsSection({
  wallet,
  streak,
}: {
  wallet: WalletData;
  streak: StreakData;
}) {
  const badgesEarned = Math.floor(streak.best_streak / 7);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary-700 dark:text-primary-300">
          Wallet &amp; Rewards
        </h2>
        <span className="rounded-full bg-accent-100 px-3 py-1 text-xs font-bold text-accent-700 dark:bg-accent-900/30 dark:text-accent-400">
          Rs {wallet.balance} available
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-surface-light p-4 dark:bg-primary-800/30">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Balance</p>
          <p className="mt-1 text-lg font-bold text-primary-700 dark:text-primary-300">
            Rs {wallet.balance}
          </p>
        </div>
        <div className="rounded-xl bg-surface-light p-4 dark:bg-primary-800/30">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Total earned</p>
          <p className="mt-1 text-lg font-bold text-primary-700 dark:text-primary-300">
            Rs {wallet.total_earned}
          </p>
        </div>
        <div className="rounded-xl bg-surface-light p-4 dark:bg-primary-800/30">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Current streak</p>
          <p className="mt-1 text-lg font-bold text-primary-700 dark:text-primary-300">
            {streak.current_streak} day{streak.current_streak === 1 ? "" : "s"}
          </p>
        </div>
        <div className="rounded-xl bg-surface-light p-4 dark:bg-primary-800/30">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Next badge</p>
          <p className="mt-1 text-lg font-bold text-primary-700 dark:text-primary-300">
            in {streak.days_to_next_badge} day
            {streak.days_to_next_badge === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {badgesEarned > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Array.from({ length: Math.min(badgesEarned, 5) }).map((_, i) => {
            const tier = (i + 1) * 7;
            return (
              <span
                key={tier}
                className="inline-flex items-center gap-1 rounded-full bg-primary-500/10 px-3 py-1 text-xs font-bold text-primary-700"
              >
                <FlameIcon filled />
                {tier}-day streak badge
              </span>
            );
          })}
        </div>
      )}
      {streak.current_streak >= 7 && (
        <p className="mt-3 rounded-lg bg-green-50 p-2 text-xs text-green-700">
          Active streak: pick up 1% cashback per order and a 10%-off coupon
          lands in your wallet every 7 consecutive days.
        </p>
      )}

      <div className="mt-5 border-t border-neutral-100 pt-4 dark:border-primary-700/30">
        <p className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Cashback history
        </p>
        {wallet.transactions.length === 0 ? (
          <p className="text-sm text-neutral-400">
            No wallet activity yet. Complete a pickup to earn 1% cashback.
          </p>
        ) : (
          <ul className="space-y-2">
            {wallet.transactions.slice(0, 10).map((tx) => (
              <li
                key={tx.id}
                className="flex items-center justify-between rounded-lg border border-neutral-100 px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-neutral-700">
                    {tx.reason === "pickup_cashback"
                      ? "Pickup cashback"
                      : "Referral bonus"}
                  </p>
                  <p className="text-xs text-neutral-400">
                    {new Date(tx.created_at).toLocaleDateString()}
                  </p>
                </div>
                <p className="font-bold text-green-600">+Rs {tx.amount}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ReferEarnCard({
  profile,
  onUpdated,
}: {
  profile: ReferralProfile;
  onUpdated: (profile: ReferralProfile) => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profile.referral_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage({ ok: false, text: "Could not copy. Select the code manually." });
    }
  }, [profile.referral_code]);

  async function handleApply() {
    const trimmed = code.trim();
    if (!trimmed || !accessToken || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await applyReferral(accessToken, trimmed);
      setCode("");
      setMessage({ ok: true, text: "Rs 50 bonus added to your wallet!" });
      onUpdated(await fetchReferralProfile(accessToken));
    } catch (err) {
      const e = err as Error & { code?: string };
      setMessage({
        ok: false,
        text:
          e.code === "FRAUD_DETECTED"
            ? "Fraud blocked: this network or device has already claimed a referral."
            : e.message,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-primary-700 dark:text-primary-300">Refer &amp; Earn</h2>
        <span className="rounded-full bg-accent-100 px-3 py-1 text-xs font-bold text-accent-700 dark:bg-accent-900/30 dark:text-accent-400">
          Earn Rs {profile.bonus_amount} per friend
        </span>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Your referral code</p>
          <p className="mt-1 text-2xl font-bold tracking-widest text-primary-700 dark:text-primary-300">
            {profile.referral_code}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copyCode}
            className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            {copied ? "Copied!" : "Copy Code"}
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-surface-light p-4 dark:bg-primary-800/30">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Wallet balance:{" "}
          <span className="font-bold text-primary-700 dark:text-primary-300">
            Rs {profile.balance}
          </span>
          <span className="text-neutral-400 dark:text-neutral-500">
            {" "}
            &middot; Rs {profile.total_earned} earned
          </span>
        </p>
      </div>

      <div className="mt-5 border-t border-neutral-100 pt-5 dark:border-primary-700/30">
        <p className="mb-2 text-sm font-medium text-neutral-600 dark:text-neutral-300">
          Have a friend&apos;s code? Apply it
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="SNKZ-XXXXXX"
            maxLength={12}
            className="flex-1 rounded-full border border-neutral-200 px-4 py-2.5 text-sm focus:border-primary-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleApply}
            disabled={!code.trim() || submitting}
            className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? "Applying..." : "Apply"}
          </button>
        </div>
        {message && (
          <p
            className={`mt-2 text-sm ${message.ok ? "text-green-600" : "text-red-500"}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}

function StampCardsSection({
  cards,
  restaurants,
  loading,
}: {
  cards: StampCard[];
  restaurants: Restaurant[];
  loading: boolean;
}) {
  const restaurantName = useCallback(
    (id: string) =>
      restaurants.find((r) => r.id === id)?.name ?? `Restaurant ${id.slice(0, 8)}`,
    [restaurants],
  );

  if (loading) {
    return (
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="h-5 w-40 animate-skeleton-teal rounded bg-primary-200" />
        <div className="mt-4 space-y-2">
          <div className="h-9 w-9 animate-skeleton-teal rounded-full bg-primary-200" />
          <div className="h-9 w-9 animate-skeleton-teal rounded-full bg-primary-200" />
          <div className="h-9 w-9 animate-skeleton-teal rounded-full bg-primary-200" />
        </div>
      </section>
    );
  }

  if (cards.length === 0) {
    return (
      <section className="rounded-2xl bg-white p-6 text-center shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
        <h2 className="text-lg font-semibold text-primary-700 dark:text-primary-300">Stamp Cards</h2>
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
          Pick up 10 orders from the same restaurant and unlock a free item.
          Your stamp cards will appear here.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-full bg-primary-500 px-6 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
        >
          Start ordering
        </Link>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <h2 className="mb-4 text-lg font-semibold text-primary-700 dark:text-primary-300">Stamp Cards</h2>
      <div className="space-y-4">
        {cards.map((card) => (
          <div key={card.restaurant_id} className="rounded-xl bg-surface-light p-4">
            <p className="mb-3 text-sm font-semibold text-primary-800">
              {restaurantName(card.restaurant_id)}
            </p>
            <StampCardProgress
              stampCount={card.stamp_count}
              rewardsEarned={card.rewards_earned}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function VipSupportCard({
  vip,
  onRefreshed,
}: {
  vip: VipStatus;
  onRefreshed: (vip: VipStatus) => void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SupportTicketResult | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const orderPct = Math.min(100, Math.round((vip.order_count / vip.order_threshold) * 100));
  const spendPct = Math.min(100, Math.round((vip.total_spend / vip.spend_threshold) * 100));

  async function handleSubmit() {
    if (!accessToken || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const ticket = await createSupportTicket(accessToken, subject, description);
      setResult(ticket);
      setSubject("");
      setDescription("");
      setOpen(false);
      onRefreshed(await fetchVipStatus(accessToken));
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-primary-900/40 dark:shadow-primary-900/20">
      <div
        className={`flex items-center justify-between px-6 py-4 ${
          vip.is_vip
            ? "bg-gradient-to-r from-primary-700 to-primary-500"
            : "bg-surface-light dark:bg-primary-800/30"
        }`}
      >
        <div>
          <h2 className={`text-lg font-semibold ${vip.is_vip ? "text-white" : "text-primary-700 dark:text-primary-300"}`}>
            VIP Customer Support
          </h2>
          <p className={`text-sm ${vip.is_vip ? "text-primary-100" : "text-neutral-500 dark:text-neutral-400"}`}>
            {vip.is_vip
              ? "You get HIGH-priority support with a dedicated operations agent."
              : "More orders and spend unlock priority support."}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            vip.is_vip ? "bg-white/20 text-white" : "bg-accent-100 text-accent-700"
          }`}
        >
          {vip.is_vip ? "VIP" : "Regular"}
        </span>
      </div>

      <div className="p-6">
        {!vip.is_vip && (
          <div className="mb-5 space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-xs text-neutral-500">
                <span>Orders · {vip.order_count} / {vip.order_threshold}</span>
                <span>{orderPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-full rounded-full bg-primary-500 transition-all"
                  style={{ width: `${orderPct}%` }}
                />
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-neutral-500">
                <span>Spend · Rs {vip.total_spend.toLocaleString()} / Rs {vip.spend_threshold.toLocaleString()}</span>
                <span>{spendPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-full rounded-full bg-primary-500 transition-all"
                  style={{ width: `${spendPct}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {result ? (
          <div className="rounded-xl bg-green-50 p-4 text-sm text-green-800">
            Ticket <span className="font-semibold">#{result.id.slice(0, 8)}</span> created.
            {result.is_vip
              ? ` It was routed to a specialized OPS_AGENT at ${result.priority} priority.`
              : ` Status is being processed at ${result.priority} priority.`}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="rounded-full bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover"
            >
              {open ? "Cancel" : "Priority Support"}
            </button>

            {open && (
              <div className="mt-4 space-y-3 rounded-xl bg-surface-light p-4">
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject (e.g. Delayed order)"
                  maxLength={120}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-primary-400 focus:outline-none"
                />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the issue…"
                  rows={3}
                  maxLength={2000}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-primary-400 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!subject.trim() || !description.trim() || submitting}
                  className="rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {submitting ? "Submitting…" : "Submit Ticket"}
                </button>
                {message && (
                  <p className={`text-sm ${message.ok ? "text-green-600" : "text-red-500"}`}>
                    {message.text}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ProfileContent() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale } = useI18n();
  const [profile, setProfile] = useState<ReferralProfile | null>(null);
  const [cards, setCards] = useState<StampCard[]>([]);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [streak, setStreak] = useState<StreakData | null>(null);
  const [tolerance, setTolerance] = useState<number | null>(null);
  const [vip, setVip] = useState<VipStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, c, r, w, s, v] = await Promise.all([
          fetchReferralProfile(accessToken),
          fetchStampCards(accessToken),
          fetchRestaurants(),
          fetchWallet(accessToken),
          fetchStreak(accessToken),
          fetchVipStatus(accessToken),
        ]);
        if (cancelled) return;
        setProfile(p);
        setCards(c);
        setRestaurants(r);
        setWallet(w);
        setStreak(s);
        setVip(v);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary-700 dark:text-primary-300">My Account</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Set your spice level, track cashback and streaks, and refer
            friends.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            className="rounded-full border border-primary-500/30 p-2 text-primary-700 hover:bg-surface-light dark:text-primary-300 dark:hover:bg-primary-900/30"
          >
            {theme === "light" ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => setLocale(locale === "en" ? "hi" : "en")}
            aria-label={`Switch language to ${locale === "en" ? "Hindi" : "English"}`}
            className="rounded-full border border-primary-500/30 px-3 py-1.5 text-xs font-bold text-primary-700 hover:bg-surface-light dark:text-primary-300 dark:hover:bg-primary-900/30 uppercase"
          >
            {locale === "en" ? "hi" : "en"}
          </button>
          <Link
            href="/"
            className="rounded-full border border-primary-500/30 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-surface-light dark:text-primary-300 dark:hover:bg-primary-900/30"
          >
            Back to Home
          </Link>
        </div>
      </header>

      <div className="space-y-6">
        {wallet && streak ? (
          <WalletRewardsSection wallet={wallet} streak={streak} />
        ) : (
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="h-5 w-48 animate-skeleton-teal rounded bg-primary-200" />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="h-20 animate-skeleton-teal rounded-xl bg-primary-200" />
              <div className="h-20 animate-skeleton-teal rounded-xl bg-primary-200" />
            </div>
          </section>
        )}

        <SpiceToleranceCard tolerance={tolerance} onSaved={setTolerance} />

        {vip ? (
          <VipSupportCard vip={vip} onRefreshed={setVip} />
        ) : (
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="h-5 w-48 animate-skeleton-teal rounded bg-primary-200" />
            <div className="mt-4 h-4 w-full animate-skeleton-teal rounded bg-primary-200" />
            <div className="mt-2 h-4 w-2/3 animate-skeleton-teal rounded bg-primary-200" />
          </section>
        )}

        {profile ? (
          <ReferEarnCard
            profile={profile}
            onUpdated={setProfile}
          />
        ) : (
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="h-5 w-40 animate-skeleton-teal rounded bg-primary-200" />
            <div className="mt-4 h-8 w-56 animate-skeleton-teal rounded bg-primary-200" />
          </section>
        )}

        <StampCardsSection
          cards={cards}
          restaurants={restaurants}
          loading={loading}
        />
      </div>
    </main>
  );
}

export default function ProfilePage() {
  return (
    <AuthGate>
      <ProfileContent />
    </AuthGate>
  );
}
