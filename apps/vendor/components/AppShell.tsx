"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LazyMotion, domMax } from "framer-motion";
import {
  Bars3Icon,
  BuildingStorefrontIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  CurrencyDollarIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  FireIcon,
  ListBulletIcon,
  PresentationChartBarIcon,
  Squares2X2Icon,
  TableCellsIcon,
  TrophyIcon,
  UserGroupIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Container } from "@snakzap/ui";
import { getSessionUser, hydrateSession, isAuthenticated, logout, type VendorSessionUser } from "@/lib/auth";
import { useVendorStore } from "@/lib/store";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const iconClass = "h-5 w-5";

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Operations",
    items: [
      {
        href: "/",
        label: "Overview",
        icon: <Squares2X2Icon className={iconClass} />,
      },
      {
        href: "/kds",
        label: "Live Orders",
        icon: <FireIcon className={iconClass} />,
      },
      {
        href: "/orders",
        label: "Orders",
        icon: <ClipboardDocumentListIcon className={iconClass} />,
      },
      {
        href: "/dine-in",
        label: "Dine-In",
        icon: <TableCellsIcon className={iconClass} />,
      },
    ],
  },
  {
    title: "Manage",
    items: [
      {
        href: "/menu",
        label: "Menu",
        icon: <Bars3Icon className={iconClass} />,
      },
      {
        href: "/menu/bulk",
        label: "Bulk Menu",
        icon: <ListBulletIcon className={iconClass} />,
      },
      {
        href: "/promotions",
        label: "Promotions",
        icon: <TrophyIcon className={iconClass} />,
      },
    ],
  },
  {
    title: "Money",
    items: [
      {
        href: "/insights",
        label: "Insights",
        icon: <ChartBarIcon className={iconClass} />,
      },
      {
        href: "/settlements",
        label: "Settlements",
        icon: <CurrencyDollarIcon className={iconClass} />,
      },
      {
        href: "/gst",
        label: "GST Reports",
        icon: <DocumentTextIcon className={iconClass} />,
      },
    ],
  },
  {
    title: "Growth",
    items: [
      {
        href: "/catering",
        label: "Catering",
        icon: <UserGroupIcon className={iconClass} />,
      },
      {
        href: "/chain",
        label: "Chain",
        icon: <BuildingStorefrontIcon className={iconClass} />,
      },
      {
        href: "/pos",
        label: "POS",
        icon: <PresentationChartBarIcon className={iconClass} />,
      },
    ],
  },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white">
        <svg
          className="h-4.5 w-4.5 h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </span>
      {!compact && (
        <div className="leading-tight">
          <p className="text-sm font-bold text-slate-900">SnakZap</p>
          <p className="text-[11px] text-slate-500">Merchant Console</p>
        </div>
      )}
    </div>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main">
      {NAV_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "bg-teal-50 text-teal-700"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    <span className={active ? "text-teal-600" : "text-slate-400"}>{item.icon}</span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// Pages that render without the merchant shell (auth + onboarding).
const STANDALONE_PATHS = ["/login", "/apply", "/apply/status"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [user, setUser] = useState<VendorSessionUser | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [ready, setReady] = useState(false);

  const restaurants = useVendorStore((s) => s.restaurants);
  const activeRestaurantId = useVendorStore((s) => s.activeRestaurantId);
  const status = useVendorStore((s) => s.status);
  const load = useVendorStore((s) => s.load);
  const setActiveRestaurantId = useVendorStore((s) => s.setActiveRestaurantId);
  const resetRestaurants = useVendorStore((s) => s.reset);

  useEffect(() => {
    let cancelled = false;

    // Read the session on the client only (avoids an SSR hydration mismatch).
    if (isAuthenticated()) {
      setUser(getSessionUser());
      setAuthenticated(true);
      setReady(true);
      return;
    }

    // The access token is now httpOnly; hydrate the user from /api/v1/auth/me
    // (covers hard reloads where in-memory state is empty).
    hydrateSession()
      .then((u) => {
        if (cancelled) return;
        if (u) {
          setUser(u);
          setAuthenticated(true);
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    // Standalone pages render without the merchant shell.
    if (STANDALONE_PATHS.includes(pathname)) return;

    // Unauthenticated visitors see the entry-point landing below.
    if (!authenticated) return;

    if (status === "idle") void load();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [pathname, router, authenticated, status, load]);

  const restaurantName =
    restaurants.find((r) => r.id === activeRestaurantId)?.name ?? null;

  if (STANDALONE_PATHS.includes(pathname)) {
    return <>{children}</>;
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div
          aria-label="Loading"
          className="h-8 w-8 animate-spin rounded-full border-2 border-teal-600 border-t-transparent"
        />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50 px-6 text-center">
        <Brand />
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-bold text-slate-900">Welcome to SnakZap Merchant</h1>
          <p className="mt-2 text-sm text-slate-500">
            Sign in to run your restaurant, or apply to onboard.
          </p>
          <div className="mt-6 space-y-3">
            <Link
              href="/login"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-teal-700"
            >
              Sign in
            </Link>
            <Link
              href="/apply"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
            >
              Apply to onboard your restaurant
            </Link>
          </div>
        </div>
      </main>
    );
  }

  async function handleLogout() {
    await logout();
    resetRestaurants();
    setUser(null);
    setAuthenticated(false);
    router.replace("/login");
  }

  return (
    <LazyMotion features={domMax} strict>
      <div className="min-h-screen bg-slate-50 text-slate-900">
        {user?.is_suspended && (
          <div
            role="alert"
            className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-red-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
          >
            <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            Your account has been suspended. Please contact support for help.
          </div>
        )}
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
          <div className="border-b border-slate-100 px-4 py-4">
            <Brand />
          </div>
          <NavLinks pathname={pathname} />
          <div className="border-t border-slate-100 px-4 py-3">
            <p className="truncate text-xs font-semibold text-slate-700">
              {restaurantName ?? "Restaurant"}
            </p>
            <p className="truncate text-[11px] text-slate-400">
              {user ? `${user.phone} · ${user.role}` : "Signed out"}
            </p>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="mt-2 inline-flex min-h-[36px] w-full items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-red-600"
            >
              Sign out
            </button>
          </div>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="absolute inset-0 bg-slate-900/50"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
                <Brand />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>
              <NavLinks pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        {/* Main column */}
        <div className="flex min-h-screen flex-col md:pl-60">
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open menu"
                className="rounded-md p-2 text-slate-500 hover:bg-slate-100 md:hidden"
              >
                <Bars3Icon className="h-5 w-5" />
              </button>
              <p className="text-sm font-semibold text-slate-700">{restaurantName ?? "SnakZap"}</p>
              {restaurants.length > 1 && (
                <label className="ml-1 flex items-center gap-1.5">
                  <span className="sr-only">Switch restaurant</span>
                  <select
                    value={activeRestaurantId ?? ""}
                    onChange={(e) => setActiveRestaurantId(e.target.value)}
                    className="max-w-[180px] rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                  >
                    {restaurants.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="font-mono text-sm tabular-nums text-slate-500">
              {new Date(now).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </header>

          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <Container maxWidth="6xl" gutter={false}>{children}</Container>
          </main>
        </div>
      </div>
    </LazyMotion>
  );
}
