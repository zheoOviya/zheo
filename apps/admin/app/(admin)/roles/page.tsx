"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchUsers,
  suspendUser,
  reactivateUser,
  updateUserRole,
  getSessionRoles,
} from "../../../lib/api";

interface RoleMeta {
  value: string;
  label: string;
  description: string;
  permissions: string[];
  accent: string;
}

const ROLES: RoleMeta[] = [
  {
    value: "CONSUMER",
    label: "Consumer",
    description: "End users who browse, order, and track food deliveries.",
    permissions: ["Place & track orders", "Group ordering", "Loyalty & VIP tiers"],
    accent: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  },
  {
    value: "VENDOR_OWNER",
    label: "Vendor Owner",
    description: "Restaurant owners running their own outlet on the platform.",
    permissions: ["Manage menu & catalog", "Accept orders", "View revenue & commissions"],
    accent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  },
  {
    value: "VENDOR_STAFF",
    label: "Vendor Staff",
    description: "Outlet staff who prepare and hand off orders.",
    permissions: ["Prepare orders", "Update order statuses", "POS terminal access"],
    accent: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  },
  {
    value: "OPS_AGENT",
    label: "Ops Agent",
    description: "Operations agents who triage support and keep things moving.",
    permissions: ["Triage support tickets", "Escalate delays", "Read-only console views"],
    accent: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  },
  {
    value: "ADMIN",
    label: "Admin",
    description: "Console operators with day-to-day management controls.",
    permissions: ["Suspend & reactivate users", "Manage vendors", "Oversee orders & tickets"],
    accent: "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400",
  },
  {
    value: "SUPER_ADMIN",
    label: "Super Admin",
    description: "Full control: roles, kill switches, order overrides, and audit.",
    permissions: ["All Admin permissions", "Change user roles", "Override order status", "Toggle kill switches"],
    accent: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  },
];

type MemberItem = Awaited<ReturnType<typeof fetchUsers>>["items"][number];

export default function RolesPage() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState("ADMIN");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const [sessionRoles, setSessionRoles] = useState<string[]>([]);

  useEffect(() => {
    getSessionRoles().then(setSessionRoles).catch(() => setSessionRoles([]));
  }, []);

  const isSuperAdmin = sessionRoles.includes("SUPER_ADMIN");

  const loadCounts = useCallback(() => {
    setLoadingCounts(true);
    Promise.all(
      ROLES.map((r) =>
        fetchUsers(1, undefined, r.value)
          .then((d) => ({ role: r.value, total: d.total }))
          .catch(() => ({ role: r.value, total: 0 })),
      ),
    )
      .then((results) => {
        const next: Record<string, number> = {};
        for (const r of results) next[r.role] = r.total;
        setCounts(next);
      })
      .finally(() => setLoadingCounts(false));
  }, []);

  const loadMembers = useCallback(
    (role: string, p: number) => {
      setLoadingMembers(true);
      setError("");
      fetchUsers(p, undefined, role)
        .then((d) => {
          setMembers(d.items);
          setTotal(d.total);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Failed to load members"))
        .finally(() => setLoadingMembers(false));
    },
    [],
  );

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    setPage(1);
    loadMembers(selected, 1);
  }, [selected, loadMembers]);

  function selectRole(role: string) {
    setSelected(role);
  }

  async function handleToggle(userId: string, isSuspended: boolean) {
    setToggling(userId);
    try {
      if (isSuspended) {
        await reactivateUser(userId);
      } else {
        await suspendUser(userId);
      }
      loadMembers(selected, page);
      loadCounts();
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
      loadMembers(selected, page);
      loadCounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role change failed");
    } finally {
      setChangingRole(null);
    }
  }

  const totalPages = Math.ceil(total / 20);
  const activeMeta = ROLES.find((r) => r.value === selected);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          Roles & Permissions
        </h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Role definitions, member counts, and assignments. Role changes require
          Super Admin.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map((r) => {
          const active = selected === r.value;
          return (
            <button
              key={r.value}
              onClick={() => selectRole(r.value)}
              className={`text-left rounded-xl border p-4 transition-colors ${
                active
                  ? "border-primary-500 bg-primary-50 dark:bg-primary-950/40 ring-1 ring-primary-500"
                  : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-primary-300 dark:hover:border-primary-800"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.accent}`}>
                  {r.label}
                </span>
                <span className="text-xs text-neutral-400">
                  {loadingCounts ? "…" : `${counts[r.value] ?? 0} members`}
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
                {r.description}
              </p>
              <ul className="mt-2 space-y-1">
                {r.permissions.map((p) => (
                  <li key={p} className="flex items-start gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    <span className="mt-0.5 text-primary-500">•</span>
                    {p}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div>
        <h3 className="mb-3 font-semibold text-neutral-900 dark:text-neutral-100">
          {activeMeta?.label} members
          <span className="ml-2 text-sm font-normal text-neutral-400">({total})</span>
        </h3>
        {loadingMembers ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                <tr>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Phone</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Role</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Status</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Joined</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {members.map((u) => (
                  <tr key={u.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-sm text-neutral-900 dark:text-neutral-100">{u.phone}</td>
                    <td className="px-4 py-3">
                      {isSuperAdmin ? (
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          disabled={changingRole === u.id}
                          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 focus:border-primary-500 outline-none disabled:opacity-50"
                        >
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
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
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
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
                {members.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-neutral-400">
                      No members with this role
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-between">
            <p className="text-sm text-neutral-500">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const next = Math.max(1, page - 1);
                  setPage(next);
                  loadMembers(selected, next);
                }}
                disabled={page <= 1}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => {
                  const next = Math.min(totalPages, page + 1);
                  setPage(next);
                  loadMembers(selected, next);
                }}
                disabled={page >= totalPages}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
