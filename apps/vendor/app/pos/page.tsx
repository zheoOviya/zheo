"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@snakzap/ui";

const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
const STORE_KEY = "snakzap_pos_store";

interface SyncResult {
  synced: number;
}

interface ImportResult {
  order_id: string;
  order_status: string;
  processed: boolean;
  idempotent: boolean;
}

interface SimulateResult {
  menu_synced: number;
  import: ImportResult;
}

type Activity =
  | { kind: "synced"; synced: number }
  | { kind: "imported"; result: ImportResult }
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

  async function syncMenu() {
    setSyncing(true);
    setError("");
    try {
      const res = await fetch(
        `/api/vendor/pos/sync-menu?restaurant_id=${RESTAURANT_ID}`,
        { method: "POST" },
      );
      const body = await res.json();
      if (body.success) {
        const result: SyncResult = body.data;
        setActivity((prev) => [
          { kind: "synced", synced: result.synced },
          ...prev,
        ]);
      } else {
        setError(body.error?.message ?? "Sync failed");
      }
    } catch {
      setError("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function sendTestOrder() {
    setTesting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/vendor/pos/simulate-order?restaurant_id=${RESTAURANT_ID}`,
        { method: "POST" },
      );
      const body = await res.json();
      if (body.success) {
        const result: SimulateResult = body.data;
        setActivity((prev) => [
          { kind: "imported", result: result.import },
          ...prev,
        ]);
      } else {
        setError(body.error?.message ?? "Test order failed");
      }
    } catch {
      setError("Test order failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-primary-400">Petpooja POS</h1>
        <p className="mt-1 text-sm text-primary-600/60">
          Import orders and sync your menu from the Petpooja POS.
        </p>
      </header>

      {!connected ? (
        <div className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
          <label
            htmlFor="store-name"
            className="mb-1 block text-sm font-medium text-primary-400"
          >
            Petpooja store name
          </label>
          <div className="flex gap-2">
            <input
              id="store-name"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="e.g. Biryani House"
              className="w-full rounded-lg border border-primary-500/20 bg-primary-950/60 px-3 py-2 text-sm text-primary-100 placeholder:text-primary-600/40 focus:border-primary-500 focus:outline-none"
            />
            <button
              onClick={connect}
              className="shrink-0 rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-600"
            >
              Connect
            </button>
          </div>
          {error ? (
            <p className="mt-2 text-sm text-red-300">{error}</p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <div>
              <p className="text-sm font-semibold text-primary-300">
                {storeName}
              </p>
              <p className="text-xs text-primary-600/60">
                Connected via webhook · <span className="text-green-400">live</span>
              </p>
            </div>
            <button
              onClick={() => {
                window.localStorage.removeItem(STORE_KEY);
                setConnected(false);
                setStoreName("");
              }}
              className="rounded-lg border border-primary-500/20 px-3 py-1.5 text-xs text-primary-600/60 hover:text-primary-400"
            >
              Disconnect
            </button>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-4">
            <button
              onClick={syncMenu}
              disabled={syncing}
              className="rounded-xl bg-primary-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-60"
            >
              {syncing ? (
                <span className="inline-flex items-center gap-2">
                  <Skeleton className="h-3 w-12" />
                  Syncing…
                </span>
              ) : (
                "Sync Menu Now"
              )}
            </button>
            <button
              onClick={sendTestOrder}
              disabled={testing}
              className="rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-400 disabled:opacity-60"
            >
              {testing ? (
                <span className="inline-flex items-center gap-2">
                  <Skeleton className="h-3 w-12" />
                  Sending…
                </span>
              ) : (
                "Send Test Order"
              )}
            </button>
          </div>

          {error ? (
            <p className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              {error}
            </p>
          ) : null}

          <section className="rounded-2xl border border-primary-500/15 bg-primary-900/30 p-4">
            <h2 className="mb-3 text-sm font-semibold text-primary-400">
              Activity
            </h2>
            {activity.length === 0 ? (
              <p className="text-sm text-primary-600/60">
                Nothing yet. Sync your menu or send a test order.
              </p>
            ) : (
              <ul className="space-y-2">
                {activity.map((entry, index) => (
                  <li
                    key={`${entry.kind}-${index}`}
                    className="rounded-lg border border-primary-500/10 bg-primary-950/40 px-3 py-2 text-sm"
                  >
                    {entry.kind === "synced" ? (
                      <span className="text-primary-300">
                        Menu sync complete · <strong>{entry.synced}</strong> items
                      </span>
                    ) : entry.kind === "imported" ? (
                      <span className="text-primary-300">
                        Order imported ·{" "}
                        <strong className="text-green-400">
                          {entry.result.order_status}
                        </strong>{" "}
                        ·{" "}
                        <span className="font-mono text-xs">
                          {entry.result.order_id.slice(0, 8)}…
                        </span>
                      </span>
                    ) : (
                      <span className="text-red-300">{entry.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
