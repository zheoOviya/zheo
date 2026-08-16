"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchVendors,
  toggleVendorStatus,
  fetchVendorApplications,
  fetchVendorApplicationMetrics,
  approveVendorApplication,
  rejectVendorApplication,
  type VendorApplicationDTO,
  type VendorApplicationMetrics,
} from "../../../lib/api";
import { getUserRole } from "../../../lib/auth";

interface Vendor {
  id: string;
  name: string;
  gst_number: string | null;
  owner_id: string;
  commission_rate: number;
  is_active: boolean;
  owner_phone: string | null;
}

const statusBadge: Record<VendorApplicationDTO["status"], string> = {
  PENDING: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  APPROVED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function Sparkline({ points }: { points: number[] }) {
  const w = 120;
  const h = 32;
  const max = Math.max(...points, 1);
  if (points.length < 2) {
    return <svg width={w} height={h} />;
  }
  const coords = points
    .map((p, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
    </div>
  );
}

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [applications, setApplications] = useState<VendorApplicationDTO[]>([]);
  const [metrics, setMetrics] = useState<VendorApplicationMetrics | null>(null);
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const role = getUserRole() ?? "";
  const canReview = role === "SUPER_ADMIN";

  const load = useCallback(() => {
    setError("");
    Promise.all([fetchVendors(), fetchVendorApplications(), fetchVendorApplicationMetrics()])
      .then(([v, a, m]) => {
        setVendors(v);
        setApplications(a);
        setMetrics(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load vendors"));
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

  async function handleReview(app: VendorApplicationDTO, decision: "approve" | "reject") {
    setReviewing(app.id);
    try {
      if (decision === "approve") {
        await approveVendorApplication(app.id);
      } else {
        const reason = window.prompt("Reason for rejection (optional):") ?? undefined;
        await rejectVendorApplication(app.id, reason);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed");
    } finally {
      setReviewing(null);
    }
  }

  const pendingCount = applications.filter((a) => a.status === "PENDING").length;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Vendor Management</h2>

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {metrics && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Total Applications" value={metrics.total} tone="text-neutral-900 dark:text-neutral-100" />
          <KpiCard label="Pending" value={metrics.pending} tone="text-amber-600 dark:text-amber-400" />
          <KpiCard label="Approved" value={metrics.approved} tone="text-green-600 dark:text-green-400" />
          <KpiCard label="Rejected" value={metrics.rejected} tone="text-red-600 dark:text-red-400" />
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 sm:col-span-2 lg:col-span-4">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              Submissions over the last {metrics.trend.length} days
            </p>
            <div className="mt-2 text-primary-600 dark:text-primary-400">
              <Sparkline points={metrics.trend.map((t) => t.submitted)} />
            </div>
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            Onboarding Applications
          </h3>
          {pendingCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {pendingCount} pending
            </span>
          )}
        </div>

        {applications.length === 0 ? (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 text-sm text-neutral-400">
            No vendor applications yet. New restaurant owners apply via the vendor console.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                <tr>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Restaurant</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">GST / FSSAI</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Contact</th>
                  <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Status</th>
                  {canReview && <th className="px-4 py-3 font-semibold text-neutral-600 dark:text-neutral-400">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {applications.map((a) => (
                  <tr key={a.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-950/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-neutral-900 dark:text-neutral-100">{a.name}</p>
                      <p className="text-xs text-neutral-500">{a.city ?? ""}{a.address ? ` — ${a.address}` : ""}</p>
                      <span className={`inline-block rounded-full px-2 py-0.5 mt-1 text-[11px] font-semibold ${
                        a.type === "CHAIN"
                          ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                      }`}>
                        {a.type === "CHAIN" ? `Chain · ${a.outlet_count} outlets` : "Single outlet"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-500">
                      <p>{a.gst_number}</p>
                      <p>{a.fssai_license}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      <p>{a.phone}</p>
                      {a.contact_email && <p>{a.contact_email}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadge[a.status]}`}>
                        {a.status}
                      </span>
                      {a.status === "REJECTED" && a.rejection_reason && (
                        <p className="mt-1 text-xs text-neutral-500">{a.rejection_reason}</p>
                      )}
                    </td>
                    {canReview && (
                      <td className="px-4 py-3">
                        {a.status === "PENDING" ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleReview(a, "approve")}
                              disabled={reviewing === a.id}
                              className="rounded-lg bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleReview(a, "reject")}
                              disabled={reviewing === a.id}
                              className="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-neutral-400">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Active Vendors</h3>
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
      </section>
    </div>
  );
}
