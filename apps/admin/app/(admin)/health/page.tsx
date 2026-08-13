"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchDashboardMetrics,
  fetchHealth,
  fetchKillSwitches,
  toggleKillSwitch,
  type DashboardMetrics,
  type HealthReport,
  type KillSwitchState,
} from "../../../lib/api";
import { isAdmin, getUserRole } from "../../../lib/auth";

const statusStyles: Record<KillSwitchState["status"], string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  warning:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  triggered: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function ComponentBadge({ label, tone }: { label: string; tone: "ok" | "warn" | "err" }) {
  const toneStyles = {
    ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    err: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${toneStyles[tone]}`}>
      {label}
    </span>
  );
}

export default function HealthPage() {
  const [switches, setSwitches] = useState<KillSwitchState[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [apiError, setApiError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const admin = isAdmin();
  const role = getUserRole() ?? "ADMIN";

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [sw, m, h] = await Promise.all([
        fetchKillSwitches(),
        fetchDashboardMetrics(),
        fetchHealth(),
      ]);
      setSwitches(sw);
      setMetrics(m);
      setHealth(h);
      setApiError("");
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed to load system status");
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 60000);
    return () => clearInterval(t);
  }, [load]);

  async function toggle(sw: KillSwitchState) {
    try {
      const updated = await toggleKillSwitch(sw.name, !sw.enabled);
      setSwitches((prev) =>
        prev.map((s) => (s.name === updated.name ? updated : s)),
      );
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed to toggle kill switch");
    }
  }

  const redisTone =
    health?.redis === "reachable" || health?.redis === "memory"
      ? ("ok" as const)
      : ("err" as const);
  const dbTone = health?.storage_mode === "postgres" ? ("ok" as const) : ("warn" as const);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            System Health
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Component status, kill switches, and live operational metrics.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-neutral-400">
              Last updated {lastUpdated}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-3 py-2 text-sm font-semibold text-white transition-colors"
          >
            <svg
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {apiError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {apiError}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">API</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`h-3 w-3 rounded-full ${metrics ? "bg-emerald-500" : "bg-neutral-400"}`}
              aria-hidden="true"
            />
            <p className="font-semibold text-neutral-800 dark:text-neutral-200">
              {metrics ? "Operational" : "Checking..."}
            </p>
          </div>
          {health && (
            <p className="mt-2 text-xs text-neutral-400">
              Response in {health.latency_ms}ms
            </p>
          )}
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Database</p>
          <div className="mt-2">
            {health ? (
              <ComponentBadge
                label={health.storage_mode === "postgres" ? "Postgres" : "In-memory"}
                tone={dbTone}
              />
            ) : (
              <p className="text-sm text-neutral-400">Checking...</p>
            )}
          </div>
          {health?.storage_mode === "memory" && (
            <p className="mt-2 text-xs text-amber-500">
              Postgres unreachable — running on in-memory fallback
            </p>
          )}
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Redis</p>
          <div className="mt-2">
            {health ? (
              <ComponentBadge
                label={health.redis === "reachable" ? "Reachable" : health.redis === "degraded" ? "Degraded" : "In-memory"}
                tone={redisTone}
              />
            ) : (
              <p className="text-sm text-neutral-400">Checking...</p>
            )}
          </div>
          {health && (
            <p className="mt-2 text-xs text-neutral-400">Rate limits & OTP store</p>
          )}
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Uptime</p>
          {health ? (
            <>
              <p className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {(health.uptime_seconds / 3600).toFixed(1)}h
              </p>
              <p className="mt-2 text-xs text-neutral-400">
                API process since boot
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-neutral-400">Checking...</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Active Orders</p>
          <p className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {metrics?.active_orders ?? "-"}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Webhook Failures</p>
          <p className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {metrics ? `${metrics.webhook_failure_pct}%` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Daily Revenue</p>
          <p className="mt-2 text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {metrics ? `₹${metrics.daily_revenue.toLocaleString("en-IN")}` : "-"}
          </p>
        </div>
      </div>

      <div>
        <h3 className="mb-3 font-semibold text-neutral-900 dark:text-neutral-100">
          Kill Switches
        </h3>
        {loading ? (
          <div className="h-32 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
        ) : (
          <div className="space-y-3">
            {switches.map((sw) => (
              <div
                key={sw.name}
                className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-neutral-800 dark:text-neutral-200">
                      {sw.name}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusStyles[sw.status]}`}
                    >
                      {sw.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
                    {sw.description}
                  </p>
                </div>
                <button
                  onClick={() => toggle(sw)}
                  disabled={!admin}
                  title={admin ? undefined : `${role} is read-only`}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
                    sw.enabled
                      ? "bg-primary-500"
                      : "bg-neutral-300 dark:bg-neutral-700"
                  }`}
                  aria-label={`${sw.enabled ? "Disable" : "Enable"} ${sw.name}`}
                >
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      sw.enabled ? "left-6" : "left-1"
                    }`}
                  />
                </button>
              </div>
            ))}
            {switches.length === 0 && !loading && (
              <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center text-sm text-neutral-400">
                No kill switches configured.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
