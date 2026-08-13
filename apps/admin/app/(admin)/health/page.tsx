"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchDashboardMetrics,
  fetchKillSwitches,
  toggleKillSwitch,
  type DashboardMetrics,
  type KillSwitchState,
} from "../../../lib/api";
import { isAdmin, getUserRole } from "../../../lib/auth";

const statusStyles: Record<KillSwitchState["status"], string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  warning:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  triggered: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export default function HealthPage() {
  const [switches, setSwitches] = useState<KillSwitchState[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [apiError, setApiError] = useState("");
  const [loading, setLoading] = useState(true);
  const admin = isAdmin();
  const role = getUserRole() ?? "ADMIN";

  const load = useCallback(() => {
    fetchKillSwitches()
      .then(setSwitches)
      .catch((e) => setApiError(e instanceof Error ? e.message : "Failed to load kill switches"))
      .finally(() => setLoading(false));
    fetchDashboardMetrics()
      .then(setMetrics)
      .catch(() => setApiError("Failed to reach the metrics API"));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          System Health
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Kill switches, API reachability, and live operational metrics.
        </p>
      </div>

      {apiError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {apiError}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">API Status</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`h-3 w-3 rounded-full ${metrics ? "bg-emerald-500" : "bg-neutral-400"}`}
              aria-hidden="true"
            />
            <p className="font-semibold text-neutral-800 dark:text-neutral-200">
              {metrics ? "Operational" : "Checking..."}
            </p>
          </div>
        </div>
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
