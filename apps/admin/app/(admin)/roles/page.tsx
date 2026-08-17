"use client";

import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import {
  fetchRoles,
  fetchUsers,
  suspendUser,
  reactivateUser,
  updateUserRole,
  deleteRole,
  createRole,
  getSessionRoles,
  type RoleDefinition,
} from "../../../lib/api";

const DEFAULT_ACCENT = "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400";

const ACCENTS = [
  "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
];

function accentFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length] ?? DEFAULT_ACCENT;
}

type MemberItem = Awaited<ReturnType<typeof fetchUsers>>["items"][number];

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [selected, setSelected] = useState("ADMIN");
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loadingRoles, setLoadingRoles] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [sessionRoles, setSessionRoles] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    label: "",
    description: "",
    permissions: "",
  });
  const [formError, setFormError] = useState("");

  useEffect(() => {
    getSessionRoles().then(setSessionRoles).catch(() => setSessionRoles([]));
  }, []);

  const isSuperAdmin = sessionRoles.includes("SUPER_ADMIN");

  const loadRoles = useCallback(() => {
    setLoadingRoles(true);
    fetchRoles()
      .then((r) => {
        setRoles(r);
        if (!r.some((x) => x.name === selected)) {
          setSelected(r.some((x) => x.name === "ADMIN") ? "ADMIN" : (r[0]?.name ?? ""));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load roles"))
      .finally(() => setLoadingRoles(false));
  }, [selected]);

  const loadMembers = useCallback(
    (role: string, p: number) => {
      if (!role) return;
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
    loadRoles();
  }, [loadRoles]);

  useEffect(() => {
    setPage(1);
    loadMembers(selected, 1);
  }, [selected, loadMembers]);

  async function handleToggle(userId: string, isSuspended: boolean) {
    setToggling(userId);
    try {
      if (isSuspended) {
        await reactivateUser(userId);
      } else {
        await suspendUser(userId);
      }
      loadMembers(selected, page);
      loadRoles();
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
      loadRoles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role change failed");
    } finally {
      setChangingRole(null);
    }
  }

  async function handleDelete(name: string) {
    setDeleting(name);
    setError("");
    try {
      await deleteRole(name);
      loadRoles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  }

  async function handleCreate() {
    setFormError("");
    const permissions = form.permissions
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!form.name.trim() || !form.label.trim() || !form.description.trim()) {
      setFormError("Name, label, and description are required");
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(form.name.trim())) {
      setFormError("Name must be SCREAMING_SNAKE_CASE, e.g. SUPPORT_LEAD");
      return;
    }
    setCreating(true);
    try {
      await createRole({
        name: form.name.trim().toUpperCase(),
        label: form.label.trim(),
        description: form.description.trim(),
        permissions,
      });
      setShowCreate(false);
      setForm({ name: "", label: "", description: "", permissions: "" });
      loadRoles();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to create role");
    } finally {
      setCreating(false);
    }
  }

  const totalPages = Math.ceil(total / 20);
  const activeMeta = roles.find((r) => r.name === selected);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            Roles & Permissions
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Role definitions, member counts, and assignments. Role changes
            require Super Admin.
          </p>
        </div>
        {isSuperAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-primary-500 hover:bg-primary-600 px-3 py-2 text-sm font-semibold text-white transition-colors"
          >
            <PlusIcon className="h-4 w-4" />
            Add Role
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loadingRoles ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roles.map((r) => {
            const active = selected === r.name;
            return (
              <div
                key={r.name}
                className={`rounded-xl border p-4 transition-colors ${
                  active
                    ? "border-primary-500 bg-primary-50 dark:bg-primary-950/40 ring-1 ring-primary-500"
                    : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
                }`}
              >
                <button onClick={() => setSelected(r.name)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.is_builtin ? accentFor(r.name) : DEFAULT_ACCENT}`}>
                      {r.label}
                      {!r.is_builtin && (
                        <span className="ml-1.5 font-normal opacity-70">custom</span>
                      )}
                    </span>
                    <span className="text-xs text-neutral-400">
                      {r.member_count} members
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
                    {r.permissions.length === 0 && (
                      <li className="text-xs italic text-neutral-400">No permissions listed</li>
                    )}
                  </ul>
                </button>
                {!r.is_builtin && isSuperAdmin && (
                  <button
                    onClick={() => handleDelete(r.name)}
                    disabled={deleting === r.name}
                    className="mt-3 rounded-lg border border-red-200 dark:border-red-900 px-2.5 py-1 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors"
                  >
                    {deleting === r.name ? "Deleting..." : "Delete role"}
                  </button>
                )}
              </div>
            );
          })}
          {roles.length === 0 && (
            <div className="col-span-full rounded-xl border border-neutral-200 dark:border-neutral-800 p-8 text-center text-sm text-neutral-400">
              No roles found.
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-3 font-semibold text-neutral-900 dark:text-neutral-100">
          {activeMeta?.label ?? "Select a role"} members
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
                          {roles.map((r) => (
                            <option key={r.name} value={r.name}>{r.label}</option>
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

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Add role">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 p-6 shadow-xl border border-neutral-200 dark:border-neutral-800">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Add Role
            </h3>
            <div className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Name (SCREAMING_SNAKE_CASE)
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="SUPPORT_LEAD"
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:border-primary-500 outline-none"
              />
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Label
              </label>
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="Support Lead"
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:border-primary-500 outline-none"
              />
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Description
              </label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What does this role do?"
                rows={2}
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:border-primary-500 outline-none"
              />
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Permissions (comma-separated)
              </label>
              <input
                value={form.permissions}
                onChange={(e) => setForm({ ...form, permissions: e.target.value })}
                placeholder="Triage tickets, Escalate"
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:border-primary-500 outline-none"
              />
              {formError && (
                <p className="text-sm text-red-500">{formError}</p>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition-colors"
              >
                {creating ? "Creating..." : "Create Role"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
