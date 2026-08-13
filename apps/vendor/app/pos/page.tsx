"use client";

import { useEffect, useState } from "react";
import { syncPosMenu, simulatePosOrder, type PosSimulateResult } from "@/lib/api";
import { shortOrderId } from "@/lib/format";
import {
  PageHeader,
  SectionCard,
  ErrorBanner,
  EmptyPanel,
  PrimaryButton,
  SecondaryButton,
} from "@/components/ui";

const STORE_KEY = "snakzap_pos_store";

type Activity =
  | { kind: "synced"; synced: boolean }
  | { kind: "imported"; result: PosSimulateResult["import"] }
  | { kind: "error"; message: string };

export default function PosPage() {
  const [storeName, setStoreName] = useState("");
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORE_KEY);
    if (stored) {
      setStoreName(stored);
      setConnected(true);
    }
  }, []);

  function connect() {
    if (!storeName.trim()) {
      setError("Enter your Petpooja store name to connect.");
      return;
    }
    setError("");
    window.localStorage.setItem(STORE_KEY, storeName.trim());
    setConnected(true);
  }

  async function handleSync() {
    setSyncing(true);
    setError("");
    try {
      const result = await syncPosMenu();
      setActivity((prev) => [{ kind: "synced", synced: result.synced }, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleTestOrder() {
    setTesting(true);
    setError("");
    try {
      const result = await simulatePosOrder();
      setActivity((prev) => [{ kind: "imported", result: result.import }, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test order failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Petpooja POS"
        subtitle="Import orders and sync your menu from the Petpooja POS"
      />

      <ErrorBanner message={error} />

      {!connected ? (
        <SectionCard title="Connect your store">
          <label className="sr-only" htmlFor="store-name">
            Petpooja store name
          </label>
          <div className="flex gap-2">
            <input
              id="store-name"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="e.g. Biryani House"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
            <PrimaryButton onClick={connect} disabled={!storeName.trim()}>
              Connect
            </PrimaryButton>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Orders arrive over a webhook. In demo mode you can send a simulated order to see the
            full flow.
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <div>
              <p className="text-sm font-semibold text-slate-800">{storeName}</p>
              <p className="text-xs text-slate-400">
                Connected via webhook · <span className="font-medium text-emerald-600">live</span>
              </p>
            </div>
            <SecondaryButton
              onClick={() => {
                window.localStorage.removeItem(STORE_KEY);
                setConnected(false);
                setStoreName("");
              }}
              className="min-h-[32px] px-3 py-1 text-xs"
            >
              Disconnect
            </SecondaryButton>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PrimaryButton onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing..." : "Sync Menu Now"}
            </PrimaryButton>
            <SecondaryButton onClick={handleTestOrder} disabled={testing}>
              {testing ? "Sending..." : "Send Test Order"}
            </SecondaryButton>
          </div>

          <SectionCard title="Activity" subtitle="Recent syncs and imported orders">
            {activity.length === 0 ? (
              <EmptyPanel title="Nothing yet" description="Sync your menu or send a test order." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {activity.map((entry, index) => (
                  <li key={`${entry.kind}-${index}`} className="py-2.5 text-sm">
                    {entry.kind === "synced" ? (
                      <span className="text-slate-700">
                        Menu sync complete · <strong className="text-teal-700">done</strong>
                      </span>
                    ) : entry.kind === "imported" ? (
                      <span className="text-slate-700">
                        Order imported ·{" "}
                        <strong className="text-emerald-600">{entry.result.order_status}</strong> ·{" "}
                        <span className="font-mono">#{shortOrderId(entry.result.order_id)}</span>
                        {entry.result.idempotent ? " (duplicate, ignored)" : ""}
                      </span>
                    ) : (
                      <span className="text-red-600">{entry.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
