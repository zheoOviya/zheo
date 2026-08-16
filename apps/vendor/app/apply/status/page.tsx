"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchMyApplications, type VendorApplication } from "@/lib/api";
import { getSessionUser, logout } from "@/lib/auth";

// ============================================
// Onboarding status (PENDING_VENDOR landing).
// A merchant who signed up but has not been approved (or has not yet
// submitted an application) lands here after sign-in and can see the
// state of their application instead of a 403 dashboard.
// ============================================

type Status = "loading" | "none" | "error" | VendorApplication["status"];

const STATUS_META: Record<Exclude<Status, "loading" | "none" | "error">, { title: string; tone: string }> = {
  PENDING: { title: "Application under review", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  APPROVED: { title: "Application approved", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  REJECTED: { title: "Application rejected", tone: "border-red-200 bg-red-50 text-red-800" },
};

export default function VendorOnboardingStatusPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [application, setApplication] = useState<VendorApplication | null>(null);
  const [phone, setPhone] = useState("");

  useEffect(() => {
    const user = getSessionUser();
    setPhone(user?.phone ?? "");

    if (!user) {
      router.replace("/login");
      return;
    }

    let cancelled = false;
    fetchMyApplications()
      .then((apps) => {
        if (cancelled) return;
        const latest = apps[0] ?? null;
        setApplication(latest);
        setStatus(latest ? latest.status : "none");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50 px-6 py-12 text-center">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-bold text-slate-900">Onboarding status</h1>
        {phone && <p className="mt-1 text-sm text-slate-500">{phone}</p>}

        {status === "loading" && (
          <div className="mt-6 flex justify-center">
            <div
              aria-label="Loading application status"
              className="h-7 w-7 animate-spin rounded-full border-2 border-teal-600 border-t-transparent"
            />
          </div>
        )}

        {status === "none" && (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            You have not submitted an application yet.
            <div className="mt-4">
              <Link
                href="/apply"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white hover:bg-teal-700"
              >
                Apply to onboard your restaurant
              </Link>
            </div>
          </div>
        )}

        {status === "error" && (
          <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
            Could not load your application status. Please try again.
          </p>
        )}

        {(status === "PENDING" || status === "APPROVED" || status === "REJECTED") && (
          <div className={`mt-6 rounded-lg border p-4 text-sm ${STATUS_META[status].tone}`}>
            <p className="font-bold">{STATUS_META[status].title}</p>
            {application?.name && <p className="mt-1">{application.name}</p>}
            {status === "PENDING" && (
              <p className="mt-2 text-xs opacity-80">
                Our team reviews applications as they come in. You will be able to access the
                merchant dashboard once approved.
              </p>
            )}
            {status === "APPROVED" && (
              <p className="mt-2 text-xs opacity-80">
                You can now sign in to your merchant dashboard.
              </p>
            )}
            {status === "REJECTED" && (
              <p className="mt-2 text-xs opacity-80">
                {application?.rejection_reason ?? "No reason was provided."}
              </p>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2">
          {(status === "none" || status === "REJECTED") && (
            <Link
              href="/apply"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              {status === "REJECTED" ? "Re-apply" : "Apply"}
            </Link>
          )}
          {status === "APPROVED" && (
            <Link
              href="/"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white hover:bg-teal-700"
            >
              Go to dashboard
            </Link>
          )}
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold text-slate-500 hover:text-slate-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
