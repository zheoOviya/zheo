// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AdminLayout from "../app/(admin)/layout";
import LoginPage from "../app/login/page";
import DashboardPage from "../app/(admin)/dashboard/page";

afterEach(() => {
  cleanup();
});

const mocks = vi.hoisted(() => ({
  getUserRole: vi.fn(() => "ADMIN"),
  isAdmin: vi.fn(() => true),
  logout: vi.fn(),
  storeSession: vi.fn(),
  usePathname: vi.fn(() => "/dashboard"),
  fetchDashboardMetrics: vi.fn(),
  getTotpStatus: vi.fn(),
  sendAdminOtp: vi.fn(),
  verifyAdminOtp: vi.fn(),
  verifyTotpLogin: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  getUserRole: mocks.getUserRole,
  isAdmin: mocks.isAdmin,
  logout: mocks.logout,
  storeSession: mocks.storeSession,
}));

vi.mock("../lib/api", () => ({
  fetchDashboardMetrics: mocks.fetchDashboardMetrics,
}));

vi.mock("../lib/totp", () => ({
  getTotpStatus: mocks.getTotpStatus,
  verifyTotpLogin: mocks.verifyTotpLogin,
}));

vi.mock("../lib/authFlow", () => ({
  sendAdminOtp: mocks.sendAdminOtp,
  verifyAdminOtp: mocks.verifyAdminOtp,
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
  mocks.getTotpStatus.mockResolvedValue({ totp_enabled: true });
});

function renderShell() {
  return render(
    <AdminLayout>
      <p>shell child</p>
    </AdminLayout>,
  );
}

describe("AU-1..AU-3 skip link and main landmark", () => {
  it("AU-1 renders a skip link in the authenticated shell", () => {
    renderShell();
    expect(screen.getByRole("link", { name: /skip to main content/i })).toBeTruthy();
  });

  it("AU-2 skip link href matches the main content id", () => {
    renderShell();
    const skip = screen.getByRole("link", { name: /skip to main content/i });
    expect(skip.getAttribute("href")).toBe("#main-content");
  });

  it("AU-3 main content target id is present and unique", () => {
    renderShell();
    const matches = document.querySelectorAll("#main-content");
    expect(matches.length).toBe(1);
    expect(matches[0]?.tagName).toBe("MAIN");
  });
});

describe("AU-4..AU-5 mobile drawer toggle wiring", () => {
  it("AU-4 toggles aria-expanded with the open state", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("AU-5 aria-controls matches the rendered drawer id", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    const controls = toggle.getAttribute("aria-controls");
    expect(controls).toBe("admin-mobile-drawer");
    fireEvent.click(toggle);
    const drawer = document.getElementById(controls as string);
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute("role")).toBe("dialog");
  });
});

describe("AU-6..AU-7 sidebar active route semantics", () => {
  it("AU-6 active sidebar item exposes aria-current=page", () => {
    renderShell();
    const active = screen.getAllByRole("link", { name: "Dashboard" });
    expect(active.length).toBeGreaterThan(0);
    for (const link of active) {
      expect(link.getAttribute("aria-current")).toBe("page");
    }
  });

  it("AU-7 inactive sidebar items have no aria-current", () => {
    renderShell();
    const inactive = screen.getAllByRole("link", { name: "Vendors" });
    expect(inactive.length).toBeGreaterThan(0);
    for (const link of inactive) {
      expect(link.getAttribute("aria-current")).toBeNull();
    }
  });
});

describe("AU-8 login label/input association", () => {
  beforeEach(() => {
    mocks.sendAdminOtp.mockResolvedValue({ phoneMasked: "+91******1234", demoOtp: "" });
    mocks.verifyAdminOtp.mockResolvedValue({ totp_required: true, totp_ticket: "t", phone: "p" });
  });

  it("associates the email label, OTP input, and TOTP input to exact controls", async () => {
    render(<LoginPage />);

    const email = screen.getByLabelText("Email Address") as HTMLInputElement;
    expect(email.id).toBe("admin-login-email");

    fireEvent.change(email, { target: { value: "admin@snakzap.dev" } });
    fireEvent.click(screen.getByRole("button", { name: /send otp/i }));

    const otp = (await screen.findByLabelText("One-time passcode")) as HTMLInputElement;
    expect(otp.id).toBe("admin-login-otp");

    fireEvent.change(otp, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    const totp = (await screen.findByLabelText("Authenticator code")) as HTMLInputElement;
    expect(totp.id).toBe("admin-login-totp");
  });

  it("keeps login ids unique", () => {
    render(<LoginPage />);
    const ids = ["admin-login-email"];
    for (const id of ids) {
      expect(document.querySelectorAll(`#${id}`).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("AU-9 representative live error alert", () => {
  it("announces a failed fetch via role=alert", async () => {
    mocks.fetchDashboardMetrics.mockRejectedValue(new Error("boom"));
    render(<DashboardPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});

// ---- Static contract audits (AU-10..AU-12) ----

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");

const AUDITED_ERROR_SURFACES = [
  "../app/(admin)/orders/page.tsx",
  "../app/(admin)/dashboard/page.tsx",
  "../app/(admin)/kill-switches/page.tsx",
  "../app/(admin)/security/page.tsx",
  "../app/(admin)/support-tickets/page.tsx",
  "../app/(admin)/users/page.tsx",
  "../app/(admin)/users/[id]/page.tsx",
  "../app/(admin)/audit-logs/page.tsx",
  "../app/(admin)/roles/page.tsx",
  "../app/(admin)/vendors/page.tsx",
  "../app/(admin)/reports/page.tsx",
  "../app/(admin)/revenue/page.tsx",
  "../app/login/page.tsx",
];

describe("AU-10 audited error surfaces are accessible", () => {
  it.each(AUDITED_ERROR_SURFACES)("%s declares role=alert", (rel) => {
    expect(read(rel)).toContain('role="alert"');
  });
});

describe("AU-11 dead Sidebar expression removed", () => {
  it("does not contain the no-op ternary", () => {
    const sidebar = read("../components/Sidebar.tsx");
    expect(sidebar).not.toContain("? group.items : group.items");
    expect(sidebar).toContain("const items = group.items;");
  });
});

describe("AU-12 arbitrary tiny-text tokens reduced", () => {
  function collect(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) out.push(...collect(full));
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  }

  it("has no text-[10px]/text-[11px] left in admin source", () => {
    const root = here("..");
    const offenders = [...collect(`${root}/app`), ...collect(`${root}/components`)].filter((f) =>
      /text-\[(10|11)px\]/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
