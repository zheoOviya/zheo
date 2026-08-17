import { chromium } from "@playwright/test";
import { ADMIN, setupDirs, makeLogger, newAuditedPage, appendJsonLine } from "./lib.mjs";

// Admin QA agent: login as demo admin (admin@snakzap.dev) and explore the
// key dashboard surfaces for console errors, blank screens, and broken data.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  }),
);

const email = args.email || "admin@snakzap.dev";

const { shots, logFile } = setupDirs("admin", email.replace(/[^a-zA-Z0-9]+/g, "_"));
const log = makeLogger(logFile, `admin:${email}`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ROUTES = [
  { path: "/dashboard", name: "dashboard" },
  { path: "/orders", name: "orders" },
  { path: "/vendors", name: "vendors" },
  { path: "/users", name: "users" },
  { path: "/revenue", name: "revenue" },
  { path: "/heatmap", name: "heatmap" },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const { page, issues, shot } = await newAuditedPage(browser, {
    viewport: { width: 1440, height: 900 },
    log,
    shots,
    prefix: email,
  });

  try {
    log(`STEP login: ${email}`);
    await page.goto(`${ADMIN}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1800);
    await page.fill('input[placeholder="admin@snakzap.dev"]', email);
    await page.waitForFunction(
      () => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "Send OTP");
        return !!b && !b.disabled;
      },
      { timeout: 8000 },
    );
    await shot("01-login");
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByPlaceholder("000000").waitFor({ timeout: 15000 });
    // demo OTP auto-fills; read it just in case
    try {
      const demo = await page.getByText(/^\d{6}$/).first().innerText();
      const cur = await page.getByPlaceholder("000000").inputValue();
      if (!cur && /^\d{6}$/.test(demo.trim())) {
        await page.fill('input[placeholder="000000"]', demo.trim());
      }
    } catch {}
    await shot("02-otp");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL((u) => u.pathname !== "/login", { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    await shot("03-post-login");

    for (const r of ROUTES) {
      log(`STEP explore: ${r.path}`);
      try {
        await page.goto(`${ADMIN}${r.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(2000);
        const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
        log(`route ${r.name}: rendered ${body.length} chars`);
        await shot(`10-${r.name}`);
      } catch (e) {
        log(`ROUTE_FAIL ${r.name}: ${e.message}`);
      }
    }

    log("DONE");
  } catch (e) {
    log(`FATAL: ${e.message}`);
    await shot("99-error").catch(() => {});
  } finally {
    appendJsonLine("/workspace/qa/output/orders.jsonl", {
      role: "admin",
      email,
      issues,
    });
    log(`ISSUES_COUNT: ${issues.length}`);
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
