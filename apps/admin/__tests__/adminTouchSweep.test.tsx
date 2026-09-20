import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), "utf8");

const countOf = (src: string, token: string) => src.split(token).length - 1;

function linkClasses(src: string, href: string): string[] {
  const re = new RegExp(`<Link\\s+href="${href}"\\s+className="([^"]*)"`, "g");
  return [...src.matchAll(re)].map((m) => m[1] ?? "");
}

const DASHBOARD = "../app/(admin)/dashboard/page.tsx";
const DINE_IN = "../app/(admin)/dine-in/page.tsx";
const SESSION = "../app/(admin)/dine-in/sessions/[sessionId]/page.tsx";
const KILL = "../app/(admin)/kill-switches/page.tsx";
const REPORTS = "../app/(admin)/reports/page.tsx";
const REVENUE = "../app/(admin)/revenue/page.tsx";
const TEAM = "../app/(admin)/team/page.tsx";
const USERS_DETAIL = "../app/(admin)/users/[id]/page.tsx";
const ERROR_PAGE = "../app/error.tsx";
const HEATMAP = "../app/heatmap/page.tsx";
const LOGIN = "../app/login/page.tsx";
const NOT_FOUND = "../app/not-found.tsx";

const HEALTH = "../app/(admin)/health/page.tsx";

const HIT_AREA_CLASSES = [
  "relative",
  "after:absolute",
  "after:inset-x-0",
  "after:-inset-y-2",
  "after:content-['']",
];

const AUTHORIZED_PROD = [
  "apps/admin/app/(admin)/dashboard/page.tsx",
  "apps/admin/app/(admin)/dine-in/page.tsx",
  "apps/admin/app/(admin)/dine-in/sessions/[sessionId]/page.tsx",
  "apps/admin/app/(admin)/kill-switches/page.tsx",
  "apps/admin/app/(admin)/reports/page.tsx",
  "apps/admin/app/(admin)/revenue/page.tsx",
  "apps/admin/app/(admin)/team/page.tsx",
  "apps/admin/app/(admin)/users/[id]/page.tsx",
  "apps/admin/app/error.tsx",
  "apps/admin/app/heatmap/page.tsx",
  "apps/admin/app/login/page.tsx",
  "apps/admin/app/not-found.tsx",
];

describe("TS-1 dashboard action links", () => {
  it("carries min-h-touch inline-flex items-center on all three action links", () => {
    const src = read(DASHBOARD);
    for (const href of ["/security", "/orders", "/kill-switches"]) {
      const classes = linkClasses(src, href);
      expect(classes.length, `dashboard link ${href} present`).toBeGreaterThan(0);
      for (const cls of classes) {
        expect(cls, `dashboard link ${href} touch policy`).toContain("min-h-touch");
        expect(cls, `dashboard link ${href} vertical center`).toContain("inline-flex");
        expect(cls, `dashboard link ${href} vertical center`).toContain("items-center");
      }
    }
  });
});

describe("TS-2 dine-in overview controls", () => {
  it("carries min-h-touch on Refresh, both selects, Previous and Next", () => {
    const src = read(DINE_IN);
    expect(countOf(src, "min-h-touch"), "dine-in touch target count").toBe(5);
    expect(src).toContain(
      'className="min-h-touch rounded-lg bg-primary-500 hover:bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors"',
    );
    expect(src).toContain('aria-label="Filter by restaurant"');
    expect(src).toContain('aria-label="Filter by session status"');
    expect(countOf(src, "min-h-touch rounded-lg border border-neutral-300 dark:border-neutral-700")).toBe(4);
  });
});

describe("TS-3 dine-in session detail", () => {
  it("gives the Back link and Refresh the touch policy", () => {
    const src = read(SESSION);
    expect(countOf(src, "min-h-touch")).toBe(2);
    const back = linkClasses(src, "/dine-in");
    expect(back.length).toBe(1);
    expect(back[0]).toContain("min-h-touch");
    expect(back[0]).toContain("inline-flex");
    expect(back[0]).toContain("items-center");
  });
});

describe("TS-4 kill-switch control", () => {
  it("carries min-h-touch on the Activate/Deactivate control", () => {
    const src = read(KILL);
    expect(countOf(src, "min-h-touch")).toBe(1);
    expect(src).toContain("min-h-touch shrink-0 rounded-lg");
  });
});

describe("TS-5 reports", () => {
  it("carries min-h-touch on Open full heatmap", () => {
    const src = read(REPORTS);
    expect(countOf(src, "min-h-touch")).toBe(1);
    const link = linkClasses(src, "/heatmap");
    expect(link.length).toBe(1);
    expect(link[0]).toContain("min-h-touch");
    expect(link[0]).toContain("inline-flex");
  });
});

describe("TS-6 revenue range controls", () => {
  it("carries min-h-touch on the shared 7/30 day range control", () => {
    const src = read(REVENUE);
    expect(countOf(src, "min-h-touch")).toBe(1);
    expect(src).toContain("min-h-touch rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors");
    expect(src).toContain("[7, 30].map");
  });
});

describe("TS-7 team controls", () => {
  it("carries min-h-touch on search, role select, action and pagination", () => {
    const src = read(TEAM);
    expect(countOf(src, "min-h-touch")).toBe(5);
    expect(src).toContain('type="search"');
    expect(src).toContain("min-h-touch rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1");
    expect(src).toContain("min-h-touch rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50");
    expect(countOf(src, "min-h-touch rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 disabled:opacity-40")).toBe(2);
  });
});

describe("TS-8 users detail back links", () => {
  it("gives all three branch instances the touch policy", () => {
    const src = read(USERS_DETAIL);
    const links = linkClasses(src, "/users");
    expect(links.length).toBe(3);
    for (const cls of links) {
      expect(cls).toContain("min-h-touch");
      expect(cls).toContain("inline-flex");
      expect(cls).toContain("items-center");
    }
  });
});

describe("TS-9 error page reset", () => {
  it("carries min-h-touch on Try Again without changing reset behavior", () => {
    const src = read(ERROR_PAGE);
    expect(countOf(src, "min-h-touch")).toBe(1);
    expect(src).toContain("min-h-touch mt-6 rounded-full bg-primary-500");
    expect(src).toContain("onClick={reset}");
  });
});

describe("TS-10 heatmap special case", () => {
  it("uses the pseudo-element hit-area and never min-h-touch", () => {
    const src = read(HEATMAP);
    expect(countOf(src, "min-h-touch")).toBe(0);
    for (const token of HIT_AREA_CLASSES) {
      expect(src, `hit-area class ${token}`).toContain(token);
    }
  });

  it("preserves the pill geometry and live toggle semantics", () => {
    const src = read(HEATMAP);
    expect(src).toContain("rounded-full px-3 py-1 text-sm font-medium transition-colors");
    expect(src).toContain('{live ? "LIVE · 30s" : "PAUSED"}');
    expect(src).toContain("setLive((v) => !v)");
  });
});

describe("TS-11 login compact buttons", () => {
  it("fixes only the two compact text buttons", () => {
    const src = read(LOGIN);
    expect(countOf(src, "min-h-touch")).toBe(2);
    expect(src).toContain(
      "min-h-touch inline-flex items-center justify-center w-full text-sm text-neutral-500 dark:text-neutral-400 hover:text-primary-500 transition-colors",
    );
    expect(src).toContain("Change email");
    expect(src).toContain("Back to email");
  });

  it("leaves the primary controls on their existing classes", () => {
    const src = read(LOGIN);
    expect(countOf(src, "disabled:opacity-50 px-4 py-3")).toBe(3);
    expect(src).toContain("min-h-touch inline-flex");
    expect(countOf(src, 'className="w-full rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 px-4 py-3 text-sm font-semibold text-white transition-colors"')).toBe(3);
  });
});

describe("TS-12 not-found navigation", () => {
  it("carries min-h-touch without changing the route", () => {
    const src = read(NOT_FOUND);
    expect(countOf(src, "min-h-touch")).toBe(1);
    const link = linkClasses(src, "/");
    expect(link.length).toBe(1);
    expect(link[0]).toContain("min-h-touch");
  });
});

const FROZEN_SWEEP_MANIFEST = [
  "apps/admin/app/(admin)/dashboard/page.tsx",
  "apps/admin/app/(admin)/dine-in/page.tsx",
  "apps/admin/app/(admin)/dine-in/sessions/[sessionId]/page.tsx",
  "apps/admin/app/(admin)/kill-switches/page.tsx",
  "apps/admin/app/(admin)/reports/page.tsx",
  "apps/admin/app/(admin)/revenue/page.tsx",
  "apps/admin/app/(admin)/team/page.tsx",
  "apps/admin/app/(admin)/users/[id]/page.tsx",
  "apps/admin/app/error.tsx",
  "apps/admin/app/heatmap/page.tsx",
  "apps/admin/app/login/page.tsx",
  "apps/admin/app/not-found.tsx",
];

const FORBIDDEN_SWEEP_SURFACE: RegExp[] = [
  /^apps\/api\//,
  /^packages\/db\//,
  /^packages\/ui\//,
  /^packages\/config\//,
  /^pnpm-lock\.yaml$/,
  /^\.github\//,
  /^e2e\//,
  /^apps\/admin\/lib\/api\.ts$/,
  /^apps\/admin\/app\/globals\.css$/,
  /tailwind/,
];

describe("TS-13 static scope and boundary contract", () => {
  it("TS-13A freezes the exact 12-file production sweep manifest", () => {
    expect(AUTHORIZED_PROD.length).toBe(12);
    expect(new Set(AUTHORIZED_PROD).size).toBe(AUTHORIZED_PROD.length);
    for (const rel of AUTHORIZED_PROD) {
      expect(rel.startsWith("apps/admin/"), `manifest path ${rel}`).toBe(true);
    }
    expect([...AUTHORIZED_PROD].sort()).toEqual([...FROZEN_SWEEP_MANIFEST].sort());
  });

  it("TS-13B never points the sweep manifest at a forbidden surface", () => {
    for (const rel of AUTHORIZED_PROD) {
      for (const re of FORBIDDEN_SWEEP_SURFACE) {
        expect(rel, `forbidden surface ${rel}`).not.toMatch(re);
      }
    }
  });

  it("TS-13C uses the frozen 44px touch utility and no arbitrary pixel min-size", () => {
    for (const rel of AUTHORIZED_PROD) {
      const src = read(`../${rel.replace(/^apps\/admin\//, "")}`);
      expect(src, `${rel} arbitrary min-height`).not.toContain("min-h-[");
      expect(src, `${rel} arbitrary min-width`).not.toContain("min-w-[");
    }
    const css = read("../app/globals.css");
    expect(css).toContain(".min-h-touch");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".min-w-touch");
    expect(css).toContain("min-width: 44px");
  });

  it("TS-13D keeps the A2c API surface free of touch-sweep tokens", () => {
    const api = read("../lib/api.ts");
    expect(api).not.toContain("min-h-touch");
    expect(api).not.toContain("min-w-touch");
    expect(api).not.toContain("after:-inset-y-2");
  });
});

describe("TS-14 intentional exceptions", () => {
  it("keeps the dine-in dense table-cell link excluded", () => {
    const src = read(DINE_IN);
    const table = src.match(/<Link\s+href=\{`\/dine-in\/sessions\/\$\{row\.session_id\}`\}\s+className="([^"]*)"/);
    expect(table, "dine-in session table link present").not.toBeNull();
    expect(table?.[1] ?? "").not.toContain("min-h-touch");
  });

  it("leaves the health toggle and heatmap pill on their own policies", () => {
    const health = read(HEALTH);
    expect(health).toContain("relative h-7 w-12");
    expect(countOf(health, "min-h-touch")).toBe(1);
    expect(read(HEATMAP)).not.toContain("min-h-touch");
  });
});

describe("TS-15 regression suites preserved", () => {
  it("keeps the frozen A2a/A2b/A2c suites in place", () => {
    expect(read("adminLayoutTouch.test.tsx")).toContain("LT-12 no fetch/business behavior change");
    expect(read("adminLayoutTouch.test.tsx")).toContain("A2B_FORBIDDEN_PATHS");
    expect(read("adminApi.test.ts").length).toBeGreaterThan(0);
    expect(read("adminAccessibility.test.tsx").length).toBeGreaterThan(0);
  });
});
