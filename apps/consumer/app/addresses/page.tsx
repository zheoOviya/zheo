"use client";

import Link from "next/link";
import { ChevronLeftIcon } from "@heroicons/react/24/outline";
import AuthGate from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";

function AddressesContent() {
  return (
    <main className="py-6 pb-28">
      <AppHeader />
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="section-eyebrow">Account</p>
          <h1 className="section-title">Saved Addresses</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Manage delivery and pickup addresses for faster checkout.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex min-h-9 items-center gap-1 rounded-full bg-white px-3.5 text-xs font-semibold text-neutral-600 shadow-elevation-1 ring-1 ring-neutral-900/5 transition-colors hover:bg-surface-light dark:bg-neutral-900 dark:text-neutral-300 dark:ring-white/10"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          Home
        </Link>
      </header>

      <div className="surface-card p-10 text-center">
        <p className="text-lg font-bold tracking-tight text-neutral-700 dark:text-neutral-200">
          No saved addresses yet
        </p>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Saved addresses will appear here once you add one during checkout.
        </p>
        <Link href="/" className="btn-primary mt-5">
          Browse Restaurants
        </Link>
      </div>
    </main>
  );
}

export default function AddressesPage() {
  return (
    <AuthGate>
      <AddressesContent />
    </AuthGate>
  );
}
