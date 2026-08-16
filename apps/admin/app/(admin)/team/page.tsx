"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchUsers,
  reactivateUser,
  suspendUser,
  updateUserRole,
  type UserListResponse,
} from "../../../lib/api";
import {
  getUserRole,
  getCurrentUserId,
  canChangeRole,
  canToggleSuspension,
} from "../../../lib/auth";

const ROLES = [
  "CONSUMER",
  "VENDOR_OWNER",
  "VENDOR_STAFF",
  "OPS_AGENT",
  "ADMIN",
  "SUPER_ADMIN",
] as const;

const roleBadge: Record<string, string> = {
  SUPER_ADMIN: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ADMIN: "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300",
  OPS_AGENT: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  VENDOR_OWNER: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  VENDOR_STAFF: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  CONSUMER: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

export default function TeamPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [data, setData] = useState<UserListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const myRole = getUserRole() ?? "ADMIN";
  const myId = getCurrentUserId();
  const canManageRoles = canChangeRole(myRole);
  const canManage = myRole === "ADMIN" || myRole === "SUPER_ADMIN";

  const load = useCallback(() => {
    setLoading(true);
    fetchUsers(page, search)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load team"))
      .finally(() => setLoading(false));
  }, [page, search]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeRole(userId: string, role: string) {
    setBusyId(userId);
    setError("");
    try {
      await updateUserRole(userId, role);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setBusyId("");
    }
  }

  async function toggleSuspension(userId: string, currentlySuspended: boolean) {
    setBusyId(userId);
    setError("");
    try {
      if (currentlySuspended) {
        await reactivateUser(userId);
      } else {
        await suspendUser(userId);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update user");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Team & Roles
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Manage operator accounts, roles, and suspension state.
          </p>
        </div>
        <div className="flex gap-3">
          <input
            type="search"
            placeholder="Search by phone..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="h-40 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 dark:bg-neutral-900 text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-semibold">Phone</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Joined</th>
                {canManage && <th className="px-4 py-3 font-semibold text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {data?.items.map((user) => (
                <tr key={user.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                  <td className="px-4 py-3 font-mono text-neutral-700 dark:text-neutral-300">
                    {user.phone}
                  </td>
                  <td className="px-4 py-3">
                    {canManageRoles ? (
                      <select
                        value={user.role}
                        disabled={busyId === user.id}
                        onChange={(e) => changeRole(user.id, e.target.value)}
                        className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleBadge[user.role] ?? roleBadge.CONSUMER}`}
                      >
                        {user.role}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                        user.is_suspended
                          ? "text-red-500"
                          : "text-emerald-600 dark:text-emerald-500"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${user.is_suspended ? "bg-red-500" : "bg-emerald-500"}`}
                        aria-hidden="true"
                      />
                      {user.is_suspended ? "Suspended" : "Active"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      {canToggleSuspension(myRole, myId, user.role, user.id) ? (
                        <button
                          onClick={() => toggleSuspension(user.id, user.is_suspended)}
                          disabled={busyId === user.id}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                            user.is_suspended
                              ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400"
                              : "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400"
                          }`}
                        >
                          {user.is_suspended ? "Reactivate" : "Suspend"}
                        </button>
                      ) : (
                        <span className="text-xs text-neutral-400">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                    No team members match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 20 && (
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-neutral-500">
            Page {page} of {Math.max(1, Math.ceil(data.total / 20))}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={page * 20 >= data.total}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
