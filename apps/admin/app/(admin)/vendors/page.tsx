"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchVendors, toggleVendorStatus } from "../../../lib/api";

interface Vendor {
  id: string;
  name: string;
  gst_number: string | null;
  owner_id: string;
  commission_rate: number;
  is_active: boolean;
  owner_phone: string | null;
}

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(() => {
    setError("");
    fetchVendors()
      .then(setVendors)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(v: Vendor) {
    setToggling(v.id);
    try {
      await toggleVendorStatus(v.id, !v.is_active);
      setVendors((prev) =>
        prev.map((x) => (x.id === v.id ? { ...x, is_active: !x.is_active } : x)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Vendor Management</h2>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
            <tr>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Name</th>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">GST</th>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Owner</th>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Commission</th>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Status</th>
              <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {vendors.map((v) => (
              <tr key={v.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100">{v.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500">{v.gst_number ?? "-"}</td>
                <td className="px-4 py-3 text-xs text-neutral-500">{v.owner_phone ?? v.owner_id.slice(0, 8)}...</td>
                <td className="px-4 py-3 text-sm">{(v.commission_rate * 100).toFixed(1)}%</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      v.is_active
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    }`}
                  >
                    {v.is_active ? "Active" : "Suspended"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleToggle(v)}
                    disabled={toggling === v.id}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      v.is_active
                        ? "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                        : "bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40"
                    }`}
                  >
                    {toggling === v.id ? "..." : v.is_active ? "Suspend" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
            {vendors.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-neutral-400">
                  No vendors found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
