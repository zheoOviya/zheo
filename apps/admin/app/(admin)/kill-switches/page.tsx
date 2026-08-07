"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchKillSwitches, toggleKillSwitch } from "../../../lib/api";

interface KillSwitchState {
  name: string;
  description: string;
  enabled: boolean;
  auto_trigger: boolean;
  trigger_condition: string;
  current_value: number | null;
  threshold: number;
  status: "ok" | "warning" | "triggered";
}

const STATUS_COLORS: Record<string, string> = {
  ok: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  warning: "bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400",
  triggered: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export default function KillSwitchesPage() {
  const [switches, setSwitches] = useState<KillSwitchState[]>([]);
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(() => {
    setError("");
    fetchKillSwitches()
      .then(setSwitches)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(sw: KillSwitchState) {
    setToggling(sw.name);
    try {
      const updated = await toggleKillSwitch(sw.name, !sw.enabled);
      setSwitches((prev) => prev.map((s) => (s.name === sw.name ? updated : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Kill Switches</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Platform protection mechanisms. Toggle manually or let auto-trigger rules activate them.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {switches.length === 0 && !error && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      )}

      <div className="space-y-4">
        {switches.map((sw) => (
          <div
            key={sw.name}
            className={`rounded-xl border bg-white dark:bg-neutral-900 p-5 transition-colors ${
              sw.enabled || sw.status === "triggered"
                ? "border-red-300 dark:border-red-800"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {sw.name.replace(/_/g, " ")}
                  </h3>
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[sw.status]}`}>
                    {sw.status.toUpperCase()}
                  </span>
                  {sw.auto_trigger && (
                    <span className="text-xs text-neutral-400">auto-trigger</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{sw.description}</p>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-neutral-400">Current Value</p>
                    <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                      {sw.current_value ?? "N/A"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-neutral-400">Threshold</p>
                    <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                      {sw.threshold}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs font-mono text-neutral-400">
                  Trigger: {sw.trigger_condition}
                </p>
              </div>
              <button
                onClick={() => handleToggle(sw)}
                disabled={toggling === sw.name}
                className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  sw.enabled
                    ? "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    : "bg-red-500 text-white hover:bg-red-600"
                }`}
              >
                {toggling === sw.name ? "..." : sw.enabled ? "Deactivate" : "Activate"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
