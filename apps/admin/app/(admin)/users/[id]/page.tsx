"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchCustomer360, type Customer360DTO } from "../../../../lib/api";

const fmt = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
      <p className="mb-3 font-semibold text-neutral-800 dark:text-neutral-200">{title}</p>
      {children}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="py-4 text-center text-sm text-neutral-400">{text}</p>;
}

export default function Customer360Page() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [data, setData] = useState<Customer360DTO | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    setError("");
    fetchCustomer360(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load customer"));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link href="/users" className="text-sm text-primary-500 hover:underline">← Back to Users</Link>
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-6 text-sm text-red-600 dark:text-red-400">
          Failed to load customer: {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/users" className="text-sm text-primary-500 hover:underline">← Back to Users</Link>
        <div className="h-32 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-48 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
      </div>
    );
  }

  const { user, vip, summary, wallet, streak } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/users" className="text-sm text-primary-500 hover:underline">← Back to Users</Link>
          <h2 className="mt-1 text-xl font-bold text-neutral-900 dark:text-neutral-100">
            Customer 360 — <span className="font-mono">{user.phone}</span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {vip.is_vip && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              VIP
            </span>
          )}
          <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            {user.role}
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${user.is_suspended ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"}`}>
            {user.is_suspended ? "Suspended" : "Active"}
          </span>
          <span className="text-xs text-neutral-400">Joined {new Date(user.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Total Spend</p>
          <p className="mt-1 text-2xl font-bold text-primary-600 dark:text-primary-400">{fmt(summary.total_spend)}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Completed Orders</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{summary.order_count}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Avg Order Value</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{fmt(summary.average_order_value)}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Wallet Balance</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-400">{fmt(wallet.balance)}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Pickup Streak</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-neutral-100">{streak.current_streak} <span className="text-sm font-normal text-neutral-400">(best {streak.best_streak})</span></p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Recent Orders">
          {data.orders.length === 0 ? <EmptyState text="No orders yet." /> : (
            <div className="space-y-2">
              {data.orders.map((o) => (
                <div key={o.id} className="flex items-center justify-between rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                  <div>
                    <p className="font-mono text-xs text-neutral-500">{o.id.slice(0, 12)}...</p>
                    <p className="text-neutral-700 dark:text-neutral-300">{o.restaurant_id.slice(0, 12)}... · {new Date(o.created_at).toLocaleString()}</p>
                  </div>
                  <div className="text-right">
                    <span className="inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">{o.status}</span>
                    <p className="mt-1 font-mono text-xs tabular-nums">Rs.{Number(o.total_amount).toFixed(0)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Support Tickets">
          {data.tickets.length === 0 ? <EmptyState text="No support tickets." /> : (
            <div className="space-y-2">
              {data.tickets.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-neutral-800 dark:text-neutral-200">{t.subject}</p>
                    <p className="text-xs text-neutral-500">{new Date(t.created_at).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${t.priority === "HIGH" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>{t.priority}</span>
                    <span className="text-xs text-neutral-500">{t.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Wallet Transactions">
          {data.wallet_transactions.length === 0 ? <EmptyState text="No wallet activity." /> : (
            <div className="space-y-2">
              {data.wallet_transactions.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                  <div>
                    <p className="text-neutral-700 dark:text-neutral-300">{t.reason.replace(/_/g, " ")}</p>
                    <p className="text-xs text-neutral-500">{new Date(t.created_at).toLocaleString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-emerald-600 dark:text-emerald-400">+Rs.{t.amount.toFixed(0)}</p>
                    <p className="text-xs text-neutral-400">bal {fmt(t.balance_after)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Referrals">
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Referral Code</dt>
              <dd className="font-mono font-semibold text-neutral-800 dark:text-neutral-200">{data.referral_code}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Referrals Given</dt>
              <dd className="font-semibold text-neutral-800 dark:text-neutral-200">{data.referrals_given.length}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500 dark:text-neutral-400">Codes Claimed</dt>
              <dd className="font-semibold text-neutral-800 dark:text-neutral-200">{data.referrals_claimed.length}</dd>
            </div>
          </dl>
          {data.referrals_given.length > 0 && (
            <div className="mt-3 space-y-1">
              {data.referrals_given.map((r) => (
                <p key={r.id} className="rounded-lg bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                  {r.claimant_user_id.slice(0, 12)}... claimed {r.referral_code} — Rs.{r.bonus_amount.toFixed(0)} on {new Date(r.created_at).toLocaleDateString()}
                </p>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="Stamp Cards">
        {data.stamp_cards.length === 0 ? <EmptyState text="No stamp cards yet." /> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.stamp_cards.map((c) => (
              <div key={c.restaurant_id} className="rounded-lg border border-neutral-100 dark:border-neutral-800 px-3 py-2 text-sm">
                <p className="font-mono text-xs text-neutral-500">{c.restaurant_id.slice(0, 12)}...</p>
                <p className="mt-1 text-neutral-700 dark:text-neutral-300">
                  <span className="font-semibold">{c.stamp_count}</span>/10 stamps · {c.total_orders} orders
                </p>
                <p className="text-xs text-neutral-500">{c.rewards_earned} reward(s) earned</p>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
