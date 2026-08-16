"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAuditLogs } from "../../../lib/api";

type AuditSummary = { title: string; detail: string; tone: string };

function summarizeAudit(action: string, metadata: Record<string, unknown>): AuditSummary {
  const m = metadata as Record<string, string | undefined>;
  switch (action) {
    case "vendor_application_approved":
      return {
        title: "Vendor application approved",
        detail: `${m.vendor_name ?? "Unknown vendor"} — restaurant created (${(m.vendor_id ?? "").slice(0, 8)})`,
        tone: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      };
    case "vendor_application_rejected":
      return {
        title: "Vendor application rejected",
        detail: `${m.vendor_name ?? "Unknown vendor"}: ${m.reason ?? "no reason given"}`,
        tone: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      };
    case "vendor_suspended":
      return {
        title: "Vendor suspended",
        detail: m.phone ?? m.vendor_id ?? "",
        tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
      };
    case "vendor_reactivated":
      return {
        title: "Vendor reactivated",
        detail: m.phone ?? m.vendor_id ?? "",
        tone: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      };
    case "kill_switch_activated":
      return {
        title: "Kill switch activated",
        detail: m.reason ?? "",
        tone: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      };
    case "kill_switch_deactivated":
      return {
        title: "Kill switch deactivated",
        detail: "",
        tone: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
      };
    default:
      return {
        title: action,
        detail: "",
        tone: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
      };
  }
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof fetchAuditLogs>> | null>(null);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    fetchAuditLogs({ page, limit: 25, action: actionFilter || undefined })
      .then(setLogs)
      .catch((e) => setError(e.message));
  }, [page, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const totalPages = logs ? Math.ceil(logs.total / logs.limit) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Audit Logs</h2>
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
        >
          <option value="">All Actions</option>
          <option value="vendor_suspended">Vendor Suspended</option>
          <option value="vendor_reactivated">Vendor Reactivated</option>
          <option value="vendor_application_approved">Application Approved</option>
          <option value="vendor_application_rejected">Application Rejected</option>
          <option value="kill_switch_activated">Kill Switch On</option>
          <option value="kill_switch_deactivated">Kill Switch Off</option>
          <option value="order_created">Order Created</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!logs && !error && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      )}

      {logs && (
        <>
          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                <tr>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Time</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Actor</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Action</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {logs.items.map((l) => {
                  const s = summarizeAudit(l.action, l.metadata);
                  return (
                    <tr key={l.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                      <td className="px-4 py-3 text-xs text-neutral-500 whitespace-nowrap">
                        {new Date(l.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                        {l.actor_id.slice(0, 12)}...
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.tone}`}>
                          {s.title}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500 max-w-xs">
                        {s.detail && <div className="truncate">{s.detail}</div>}
                        {Object.keys(l.metadata).length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
                              raw metadata
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] text-neutral-400">
                              {JSON.stringify(l.metadata, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {logs.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-neutral-400">
                      No audit entries found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">
                Page {page} of {totalPages} ({logs.total} entries)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
