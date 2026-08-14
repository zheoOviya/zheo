"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { fetchUsers, suspendUser, reactivateUser, updateUserRole, getSessionRoles } from "../../../lib/api";

const ALL_ROLES = ["CONSUMER", "VENDOR_OWNER", "VENDOR_STAFF", "OPS_AGENT", "ADMIN", "SUPER_ADMIN"] as const;

async function getRoles(): Promise<string[]> {
  try {
    return await getSessionRoles();
  } catch {
    return [];
  }
}

export default function UsersPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchUsers>> | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const [sessionRoles, setSessionRoles] = useState<string[]>([]);

  useEffect(() => { getRoles().then(setSessionRoles); }, []);

  const isSuperAdmin = sessionRoles.includes("SUPER_ADMIN");

  const load = useCallback(() => {
    setError("");
    fetchUsers(page, search || undefined)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  function handleSearch() {
    setPage(1);
    setSearch(searchInput);
  }

  async function handleToggle(userId: string, isSuspended: boolean) {
    setToggling(userId);
    try {
      if (isSuspended) {
        await reactivateUser(userId);
      } else {
        await suspendUser(userId);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setToggling(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setChangingRole(userId);
    try {
      await updateUserRole(userId, newRole);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role change failed");
    } finally {
      setChangingRole(null);
    }
  }

  const totalPages = data ? Math.ceil(data.total / 20) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Users</h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search by phone..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none"
          />
          <button
            onClick={handleSearch}
            className="rounded-lg bg-primary-500 hover:bg-primary-600 px-3 py-2 text-sm font-semibold text-white transition-colors"
          >
            Search
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                <tr>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Phone</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Role</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Status</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Created</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {data.items.map((u) => (
                  <tr key={u.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-sm text-neutral-900 dark:text-neutral-100">
                      <Link href={`/users/${u.id}`} className="hover:text-primary-500 hover:underline" title="Open Customer 360">
                        {u.phone}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {isSuperAdmin ? (
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          disabled={changingRole === u.id}
                          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none disabled:opacity-50"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="inline-block rounded-full bg-neutral-100 dark:bg-neutral-800 px-2.5 py-0.5 text-xs font-semibold text-neutral-600 dark:text-neutral-400">
                          {u.role}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                          u.is_suspended
                            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                            : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        }`}
                      >
                        {u.is_suspended ? "Suspended" : "Active"}
                      </span>
                      {u.suspended_reason && u.is_suspended && (
                        <p className="mt-1 text-xs text-neutral-500">{u.suspended_reason}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(u.id, u.is_suspended)}
                        disabled={toggling === u.id}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                          u.is_suspended
                            ? "bg-green-50 text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40"
                            : "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                        }`}
                      >
                        {toggling === u.id ? "..." : u.is_suspended ? "Reactivate" : "Suspend"}
                      </button>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-400">
                      No users found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-500">Page {page} of {totalPages} ({data.total} users)</p>
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
