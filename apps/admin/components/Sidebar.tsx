"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowRightStartOnRectangleIcon,
  ArrowTrendingUpIcon,
  BuildingStorefrontIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  PowerIcon,
  ShieldCheckIcon,
  SignalIcon,
  Squares2X2Icon,
  TagIcon,
  UserGroupIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { getUserRole, isAdmin, logout } from "../lib/auth";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

interface NavGroup {
  label: string;
  adminOnly?: boolean;
  items: NavItem[];
}

const iconCls =
  "h-5 w-5 shrink-0";

const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: <Squares2X2Icon className={iconCls} />,
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/orders",
        label: "Live Orders",
        icon: <ClipboardDocumentListIcon className={iconCls} />,
      },
      {
        href: "/vendors",
        label: "Vendors",
        icon: <BuildingStorefrontIcon className={iconCls} />,
      },
      {
        href: "/heatmap",
        label: "Demand Heatmap",
        icon: <SignalIcon className={iconCls} />,
      },
      {
        href: "/support-tickets",
        label: "Support Tickets",
        icon: <ChatBubbleLeftRightIcon className={iconCls} />,
      },
    ],
  },
  {
    label: "Governance",
    adminOnly: true,
    items: [
      {
        href: "/users",
        label: "Users",
        icon: <UserGroupIcon className={iconCls} />,
      },
      {
        href: "/team",
        label: "Team & Roles",
        icon: <UserIcon className={iconCls} />,
      },
      {
        href: "/roles",
        label: "Roles & Permissions",
        icon: <TagIcon className={iconCls} />,
      },
      {
        href: "/kill-switches",
        label: "Kill Switches",
        icon: <PowerIcon className={iconCls} />,
      },
      {
        href: "/audit-logs",
        label: "Audit Logs",
        icon: <ClockIcon className={iconCls} />,
      },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        href: "/reports",
        label: "Reports",
        icon: <ChartBarIcon className={iconCls} />,
      },
      {
        href: "/revenue",
        label: "Revenue Analytics",
        icon: <ArrowTrendingUpIcon className={iconCls} />,
      },
      {
        href: "/health",
        label: "System Health",
        icon: <CheckCircleIcon className={iconCls} />,
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        href: "/security",
        label: "Security & 2FA",
        icon: <ShieldCheckIcon className={iconCls} />,
      },
    ],
  },
];

export default function Sidebar({
  className = "hidden md:flex md:flex-col md:w-64 md:fixed md:inset-y-0 bg-white dark:bg-neutral-950 border-r border-neutral-200 dark:border-neutral-800 z-30",
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const role = getUserRole() ?? "ADMIN";
  const admin = isAdmin();
  const roleColor =
    role === "SUPER_ADMIN"
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      : role === "ADMIN"
        ? "bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300"
        : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";

  return (
    <aside className={className}>
      <div className="flex h-16 items-center px-6 border-b border-neutral-200 dark:border-neutral-800">
        <Link href="/dashboard" className="text-lg font-bold text-primary-500">
          SnakZap Ops
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {navGroups.map((group) => {
          if (group.adminOnly && !admin) return null;
          const items = group.adminOnly ? group.items : group.items;
          return (
            <div key={group.label}>
              <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(item.href + "/");
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigate}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                          : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                      }`}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-neutral-200 dark:border-neutral-800 px-6 py-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${roleColor}`}>
            {role}
          </span>
        </div>
        <button
          onClick={async () => {
            // Blacklist the refresh token + clear the cookie server-side, then
            // drop the local session and bounce to the login page.
            await logout();
            window.location.href = "/login";
          }}
          className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 hover:text-red-500 transition-colors"
        >
          <ArrowRightStartOnRectangleIcon className="h-4 w-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
