"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// ============================================
// Vendor login page (informational only).
//
// RATIONALE: The vendor app intentionally has no manual sign-in page and
// nothing links here. The KDS dashboard (/) is open to kitchen staff, and the
// role-gated sections (catering, chain) silently authenticate via the demo
// OTP login (dev OTP 111111) through lib/cateringAuth.ts. A direct hit on
// /login therefore shows an informative message and bounces the user back to
// the dashboard instead of a bare 404.
// ============================================

export default function VendorLoginPage() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setTimeout(() => router.replace("/"), 2500);
    return () => window.clearTimeout(timer);
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8">
        <h1 className="text-lg font-bold text-primary-400">SnakZap Kitchen</h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          This console has no sign-in page. The kitchen dashboard is open to
          staff, and the catering &amp; chain sections sign in automatically in
          demo mode.
        </p>
        <p className="mt-3 text-xs text-neutral-500" aria-live="polite">
          Redirecting you to the dashboard...
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-primary px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-primary-hover"
        >
          Go to Dashboard
        </Link>
      </div>
    </main>
  );
}
