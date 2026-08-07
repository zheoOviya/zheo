"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchSupportTickets, updateSupportTicket } from "../../../lib/api";

const PRIORITY_COLORS: Record<string, string> = {
  LOW: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  MEDIUM: "bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400",
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  IN_PROGRESS: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  RESOLVED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  CLOSED: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
};

const ASSIGNABLE_ROLES = ["OPS_AGENT", "ADMIN", "SUPER_ADMIN"];

export default function SupportTicketsPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchSupportTickets>> | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError("");
    fetchSupportTickets({
      page,
      status: statusFilter || undefined,
      priority: priorityFilter || undefined,
    })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [page, statusFilter, priorityFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleStatusChange(ticketId: string, newStatus: string) {
    try {
      await updateSupportTicket(ticketId, { status: newStatus });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function handleAssigneeChange(ticketId: string, assignee: string) {
    try {
      await updateSupportTicket(ticketId, { assignee: assignee || null });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignee update failed");
    }
  }

  const totalPages = data ? Math.ceil(data.total / 20) : 0;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Support Tickets</h2>

      <div className="flex flex-wrap gap-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
        >
          <option value="">All Statuses</option>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="RESOLVED">Resolved</option>
          <option value="CLOSED">Closed</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => { setPriorityFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
        >
          <option value="">All Priorities</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="space-y-3">
            {data.items.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_COLORS[t.priority]}`}>
                        {t.priority}
                      </span>
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_COLORS[t.status]}`}>
                        {t.status.replace("_", " ")}
                      </span>
                      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t.subject}</h3>
                    </div>
                    <div className="mt-1 flex gap-3 text-xs text-neutral-500">
                      <span>User: {t.user_id.slice(0, 12)}...</span>
                      {t.assignee && <span>Assignee: {t.assignee}</span>}
                      <span>{new Date(t.created_at).toLocaleString()}</span>
                    </div>
                    {expandedId === t.id && (
                      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-950 rounded-lg p-3">
                        {t.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                      className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                    >
                      {expandedId === t.id ? "Hide" : "View"}
                    </button>
                    <select
                      value={t.assignee ?? ""}
                      onChange={(e) => handleAssigneeChange(t.id, e.target.value)}
                      className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-neutral-600 dark:text-neutral-400 focus:border-primary-500 outline-none"
                    >
                      <option value="">Unassigned</option>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    {t.status !== "CLOSED" && t.status !== "RESOLVED" && (
                      <>
                        <button
                          onClick={() => handleStatusChange(t.id, "IN_PROGRESS")}
                          className="rounded-lg bg-primary-500 hover:bg-primary-600 px-2.5 py-1 text-xs text-white transition-colors"
                        >
                          Start
                        </button>
                        <button
                          onClick={() => handleStatusChange(t.id, "RESOLVED")}
                          className="rounded-lg bg-green-500 hover:bg-green-600 px-2.5 py-1 text-xs text-white transition-colors"
                        >
                          Resolve
                        </button>
                      </>
                    )}
                    {(t.status === "IN_PROGRESS" || t.status === "RESOLVED") && (
                      <button
                        onClick={() => handleStatusChange(t.id, "CLOSED")}
                        className="rounded-lg bg-neutral-500 hover:bg-neutral-600 px-2.5 py-1 text-xs text-white transition-colors"
                      >
                        Close
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {data.items.length === 0 && (
              <p className="text-center text-sm text-neutral-400 py-8">No tickets found</p>
            )}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">Page {page} of {totalPages} ({data.total} tickets)</p>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors">
                  Previous
                </button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors">
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
