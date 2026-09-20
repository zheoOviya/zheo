// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AdminLayout from "../app/(admin)/layout";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  getUserRole: vi.fn(() => "ADMIN"),
  isAdmin: vi.fn(() => true),
  logout: vi.fn(),
  usePathname: vi.fn(() => "/dashboard"),
}));

vi.mock("../lib/auth", () => ({
  getUserRole: mocks.getUserRole,
  isAdmin: mocks.isAdmin,
  logout: mocks.logout,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.usePathname(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usePathname.mockReturnValue("/dashboard");
  mocks.getUserRole.mockReturnValue("ADMIN");
  mocks.isAdmin.mockReturnValue(true);
});

// ---- helpers ----

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");
const repoRoot = here("../../..");

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function renderShell() {
  return render(
    <AdminLayout>
      <p>shell child</p>
    </AdminLayout>,
  );
}

const classOf = (el: Element) => el.getAttribute("class") ?? "";
const countOf = (source: string, token: string) =>
  (source.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;

const LAYOUT = "../app/(admin)/layout.tsx";
const SIDEBAR = "../components/Sidebar.tsx";
const ORDERS = "../app/(admin)/orders/page.tsx";
const SUPPORT = "../app/(admin)/support-tickets/page.tsx";
const SECURITY = "../app/(admin)/security/page.tsx";
const HEALTH = "../app/(admin)/health/page.tsx";
const ROLES = "../app/(admin)/roles/page.tsx";
const AUDIT = "../app/(admin)/audit-logs/page.tsx";
const USERS = "../app/(admin)/users/page.tsx";
const VENDORS = "../app/(admin)/vendors/page.tsx";

// Minimum number of min-h-touch occurrences frozen by the A2b-A1 design gate.
const TOUCH_MIN: Record<string, number> = {
  [LAYOUT]: 2,
  [SIDEBAR]: 3,
  [ORDERS]: 6,
  [SUPPORT]: 9,
  [SECURITY]: 4,
  [HEALTH]: 1,
  [ROLES]: 11,
  [AUDIT]: 3,
  [USERS]: 6,
  [VENDORS]: 3,
};

describe("LT-1 global content frame", () => {
  it("renders a single main landmark carrying the global frame contract", () => {
    renderShell();
    const mains = document.querySelectorAll("#main-content");
    expect(mains.length).toBe(1);
    const main = mains[0];
    if (!main) throw new Error("missing #main-content");
    expect(main.tagName).toBe("MAIN");
    const cls = classOf(main);
    for (const token of ["mx-auto", "w-full", "max-w-7xl", "p-4", "md:p-8"]) {
      expect(cls).toContain(token);
    }
  });

  it("layout source uses the shared Container as the main frame", () => {
    const src = read(LAYOUT);
    expect(src).toContain('from "@snakzap/ui"');
    expect(src).toContain("<Container");
    expect(src).toContain('as="main"');
    expect(src).toContain('id="main-content"');
    expect(src).toContain('maxWidth="7xl"');
    expect(src).toContain("gutter={false}");
    expect(src).toContain('className="p-4 md:p-8"');
  });
});

describe("LT-2 single global frame", () => {
  it("does not introduce a second max-w-7xl frame in targeted route wrappers", () => {
    expect(countOf(read(LAYOUT), "<Container")).toBe(1);
    for (const rel of [ORDERS, SECURITY, HEALTH, ROLES, AUDIT, USERS, VENDORS, SUPPORT]) {
      expect(read(rel)).not.toContain("max-w-7xl");
    }
  });
});

describe("LT-3 standard page inherits frame", () => {
  it("orders keeps no page-local max-width", () => {
    const src = read(ORDERS);
    expect(src).toContain('className="space-y-6"');
    expect(src).not.toContain("max-w-");
    expect(src).not.toContain("mx-auto");
  });
});

describe("LT-4 focused widths", () => {
  it("security is centered at max-w-2xl", () => {
    expect(read(SECURITY)).toContain("space-y-6 max-w-2xl mx-auto");
  });

  it("health is centered at max-w-4xl", () => {
    expect(read(HEALTH)).toContain("space-y-6 max-w-4xl mx-auto");
  });

  it("roles inherits the global frame", () => {
    const src = read(ROLES);
    expect(src).toContain('className="space-y-6"');
    expect(src).not.toContain("max-w-5xl");
  });
});

describe("LT-5 audit-log overflow", () => {
  it("table wrapper is horizontally scrollable and not clipped", () => {
    const src = read(AUDIT);
    expect(src).toContain("overflow-x-auto rounded-xl");
    expect(src).not.toContain("overflow-hidden");
  });
});

describe("LT-6 menu toggle", () => {
  it("meets the 44px square policy and preserves A2a ARIA", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    const cls = classOf(toggle);
    expect(cls).toContain("min-h-touch");
    expect(cls).toContain("min-w-touch");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("admin-mobile-drawer");
  });
});

describe("LT-7 header sign-out", () => {
  it("meets the minimum touch height", () => {
    renderShell();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(classOf(signOut)).toContain("min-h-touch");
  });
});

describe("LT-8 orders touch policy", () => {
  it("normalizes every A1-identified compact filter/override control", () => {
    const src = read(ORDERS);
    expect(countOf(src, "min-h-touch")).toBeGreaterThanOrEqual(TOUCH_MIN[ORDERS] ?? 0);
    expect(src).toContain("handleOverride");
  });
});

describe("LT-9 support tickets touch + wrap", () => {
  it("normalizes action controls and wraps the action row", () => {
    const src = read(SUPPORT);
    expect(countOf(src, "min-h-touch")).toBeGreaterThanOrEqual(TOUCH_MIN[SUPPORT] ?? 0);
    expect(src).toContain("flex items-center gap-2 flex-wrap");
    expect(src).toContain("handleStatusChange");
    expect(src).toContain("handleAssigneeChange");
  });
});

describe("LT-10 sidebar targets", () => {
  it("normalizes nav links, sign-out, and the brand link", () => {
    renderShell();
    const nav = screen.getByRole("link", { name: "Live Orders" });
    expect(classOf(nav)).toContain("min-h-touch");
    const brand = screen.getByRole("link", { name: "SnakZap Ops" });
    expect(classOf(brand)).toContain("min-h-touch");
    expect(classOf(brand)).toContain("inline-flex");
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(classOf(signOut)).toContain("min-h-touch");
    expect(read(SIDEBAR)).toContain("const items = group.items;");
  });
});

describe("LT-11 authorized-file compact-control scan", () => {
  it.each(Object.entries(TOUCH_MIN))("%s meets the frozen touch minimum", (rel, min) => {
    expect(countOf(read(rel), "min-h-touch")).toBeGreaterThanOrEqual(min);
  });

  it("keeps the health toggle switch as the only documented exception", () => {
    const src = read(HEALTH);
    expect(src).toContain("relative h-7 w-12");
    expect(src).not.toContain("min-h-touch rounded-full");
    expect(countOf(src, "min-h-touch")).toBe(1);
  });

  it("does not use arbitrary pixel min-height utilities for touch", () => {
    for (const rel of Object.keys(TOUCH_MIN)) {
      const src = read(rel);
      expect(src).not.toContain("min-h-[44px]");
      expect(src).not.toContain("min-height: 44px");
      expect(src).not.toContain("min-height:44px");
    }
  });
});

describe("LT-12 no fetch/business behavior change", () => {
  const API_IMPORTS: Record<string, string[]> = {
    [ORDERS]: ["fetchLiveOrders", "fetchOrderDetail", "overrideOrderStatus", "OrderDetailDTO"],
    [USERS]: ["fetchUsers", "suspendUser", "reactivateUser", "updateUserRole", "getSessionRoles"],
    [VENDORS]: [
      "fetchVendors",
      "toggleVendorStatus",
      "fetchVendorApplications",
      "fetchVendorApplicationMetrics",
      "approveVendorApplication",
      "rejectVendorApplication",
      "VendorApplicationDTO",
      "VendorApplicationMetrics",
    ],
    [SUPPORT]: ["fetchSupportTickets", "updateSupportTicket"],
    [AUDIT]: ["fetchAuditLogs"],
    [ROLES]: [
      "fetchRoles",
      "fetchUsers",
      "suspendUser",
      "reactivateUser",
      "updateUserRole",
      "deleteRole",
      "createRole",
      "getSessionRoles",
      "RoleDefinition",
    ],
    [HEALTH]: [
      "fetchDashboardMetrics",
      "fetchHealth",
      "fetchKillSwitches",
      "toggleKillSwitch",
      "DashboardMetrics",
      "HealthReport",
      "KillSwitchState",
    ],
  };

  function apiSymbols(src: string): string[] | null {
    const m = src.match(/import\s*\{([^{}]*)\}\s*from\s*"\.\.\/\.\.\/\.\.\/lib\/api"/);
    if (!m) return null;
    return (m[1] ?? "")
      .split(",")
      .map((s) => s.replace(/\btype\b/g, "").trim())
      .filter(Boolean)
      .sort();
  }

  it("keeps the exact frozen lib/api import surface per authorized file", () => {
    for (const [rel, expected] of Object.entries(API_IMPORTS)) {
      const symbols = apiSymbols(read(rel));
      expect(symbols, `lib/api import surface for ${rel}`).toEqual([...expected].sort());
    }
  });

  it("does not add a lib/api import to files that never had one", () => {
    expect(read(SECURITY)).not.toContain("lib/api");
    expect(read(LAYOUT)).not.toContain("lib/api");
    expect(read(SIDEBAR)).not.toContain("lib/api");
  });

  it("preserves the known mutation handlers", () => {
    expect(read(USERS)).toContain("handleRoleChange");
    expect(read(USERS)).toContain("handleToggle");
    expect(read(VENDORS)).toContain("handleReview");
    expect(read(VENDORS)).toContain("handleToggle");
    expect(read(ROLES)).toContain("handleDelete");
    expect(read(ROLES)).toContain("handleCreate");
  });

  it("does not modify apps/admin/lib/api.ts (diff-level)", () => {
    const changed = git(["diff", "--name-only"]).split("\n").filter(Boolean);
    expect(changed).not.toContain("apps/admin/lib/api.ts");
  });

  it("keeps the change set inside the authorized A2b scope", () => {
    const changed = git(["diff", "--name-only"]).split("\n").filter(Boolean);
    const authorized = [
      "apps/admin/app/(admin)/layout.tsx",
      "apps/admin/components/Sidebar.tsx",
      "apps/admin/app/(admin)/orders/page.tsx",
      "apps/admin/app/(admin)/support-tickets/page.tsx",
      "apps/admin/app/(admin)/security/page.tsx",
      "apps/admin/app/(admin)/health/page.tsx",
      "apps/admin/app/(admin)/roles/page.tsx",
      "apps/admin/app/(admin)/audit-logs/page.tsx",
      "apps/admin/app/(admin)/users/page.tsx",
      "apps/admin/app/(admin)/vendors/page.tsx",
    ];
    for (const file of changed) {
      expect(authorized, `unexpected changed file: ${file}`).toContain(file);
    }
    for (const forbidden of [
      "pnpm-lock.yaml",
      "apps/admin/app/globals.css",
      "apps/admin/tailwind.config.ts",
      "packages/ui/src/Container.tsx",
      "packages/config/tailwind.config.ts",
    ]) {
      expect(changed).not.toContain(forbidden);
    }
    expect(changed.some((f) => f.startsWith("e2e/") || f.startsWith(".github/"))).toBe(false);
    expect(changed.some((f) => f.startsWith("apps/api/") || f.startsWith("packages/db/"))).toBe(false);
  });
});
