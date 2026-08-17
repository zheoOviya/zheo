"use client";

import { useState } from "react";
import { ArrowRightStartOnRectangleIcon, Bars3Icon } from "@heroicons/react/24/outline";
import Sidebar from "../../components/Sidebar";
import { getUserRole, logout } from "../../lib/auth";

function RoleBadge() {
  const role = getUserRole() ?? "ADMIN";
  const roleColor =
    role === "SUPER_ADMIN"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      : role === "ADMIN"
        ? "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300"
        : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleColor}`}>
      {role}
    </span>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface-light dark:bg-surface-dark">
      <Sidebar />
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0">
            <Sidebar
              className="flex flex-col w-64 h-full bg-white dark:bg-neutral-950 border-r border-neutral-200 dark:border-neutral-800 shadow-xl"
              onNavigate={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}
      <div className="md:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-950/80 backdrop-blur px-4 md:px-8">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="md:hidden rounded-lg p-2 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            aria-label="Toggle sidebar"
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            SnakZap Ops Console
          </h1>
          <div className="ml-auto flex items-center gap-3">
            <RoleBadge />
            <button
              onClick={async () => {
                await logout();
                window.location.href = "/login";
              }}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-red-500 transition-colors"
              aria-label="Sign out"
            >
              <ArrowRightStartOnRectangleIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </header>
        <main className="p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
