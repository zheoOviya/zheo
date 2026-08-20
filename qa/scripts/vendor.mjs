import { chromium } from "@playwright/test";
import { VENDOR, setupDirs, makeLogger, newAuditedPage, appendJsonLine } from "./lib.mjs";

// Vendor QA agent: login as Biryani House owner (9876000101), process every
// CONFIRMED order through Preparing -> Almost Ready -> Ready (capturing the
// pickup code), then Confirm Pickup to complete the journey.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  }),
);

const phone = args.phone || "9876000101";
const readyHoldMs = Number(args.readyHoldMs || 15000); // let customers capture "Ready"

const { shots, logFile } = setupDirs("vendor", phone);
const log = makeLogger(logFile, `vendor:${phone}`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function filterChip(page, label) {
  return page.getByRole("button", { name: new RegExp(`^${label}`) }).first();
}

async function readPickupOtp(page) {
  const els = page.locator("p.font-mono");
  const n = await els.count();
  for (let i = 0; i < n; i++) {
    const text = (await els.nth(i).innerText()).trim();
    if (/^\d{4}$/.test(text)) return text;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const { page, issues, shot } = await newAuditedPage(browser, {
    viewport: { width: 1280, height: 900 },
    log,
    shots,
    prefix: phone,
  });

  const processed = [];

  try {
    // Login
    log(`STEP login: ${phone}`);
    await page.goto(`${VENDOR}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1800);
    await page.fill('input[placeholder="+91XXXXXXXXXX"]', phone);
    await page.waitForFunction(
      () => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "Send OTP");
        return !!b && !b.disabled;
      },
      { timeout: 8000 },
    );
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByPlaceholder("000000").waitFor({ timeout: 15000 });
    let code = "123456";
    try {
      const labelText = await page.locator("label", { hasText: "OTP code" }).innerText();
      const m = labelText.match(/Demo code:\s*(\d{6})/);
      if (m) code = m[1];
    } catch {}
    log(`demo otp: ${code}`);
    await page.fill('input[placeholder="000000"]', code);
    await shot("01-login-otp");
    await page.getByRole("button", { name: "Verify & sign in" }).click();
    await page.waitForURL((u) => u.pathname === "/" || u.pathname.includes("apply/status"), { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    await shot("02-dashboard");

    // Orders page
    log("STEP orders page");
    await page.goto(`${VENDOR}/orders`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    await shot("03-orders-list");

    // --- Phase 1: accept + advance to READY ---
    await filterChip(page, "New").click();
    await sleep(1000);
    const newRows = page.locator("tbody tr");
    const newCount = await newRows.count();
    log(`new (CONFIRMED) orders: ${newCount}`);
    await shot("04-orders-filtered");

    for (let i = 0; i < newCount; i++) {
      await newRows.nth(0).click(); // always first row (list re-filters as status changes)
      await sleep(700);
      await shot(`05-order-detail-${i}`);

      let pickupOtp = null;
      const advanceLabels = ["Start Preparing", "Mark Almost Ready", "Mark Ready"];
      for (const label of advanceLabels) {
        const btn = page.getByRole("button", { name: new RegExp(label) });
        if ((await btn.count()) === 0) {
          log(`skip ${label} (not available)`);
          break;
        }
        await btn.first().click();
        await sleep(1000);
        log(`advanced: ${label}`);
        await shot(`06-${label.replace(/\s+/g, "-").toLowerCase()}-${i}`);
      }

      pickupOtp = await readPickupOtp(page);
      if (pickupOtp) log(`pickup OTP captured: ${pickupOtp}`);

      processed.push({ pickupOtp });
      await page.getByRole("button", { name: "Close order details" }).click().catch(async () => {
        await page.keyboard.press("Escape");
      });
      await sleep(600);
    }

    // --- Hold so customers capture "Ready" ---
    log(`holding ${readyHoldMs}ms for customers to capture Ready state`);
    await sleep(readyHoldMs);
    await shot("07-ready-hold");

    // Reload so the fresh orders list includes pickup_otp (handleAdvance only
    // patches status in local state, so the code is absent until a refetch).
    log("reload orders page to fetch pickup_otp");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // --- Phase 2: confirm pickup for READY orders ---
    await filterChip(page, "Ready").click();
    await sleep(1000);
    const readyRows = page.locator("tbody tr");
    const readyCount = await readyRows.count();
    log(`ready orders to hand over: ${readyCount}`);

    for (let i = 0; i < readyCount; i++) {
      await readyRows.nth(0).click();
      await sleep(700);
      const otpInput = page.locator('input[placeholder="Enter customer OTP"]');
      if ((await otpInput.count()) === 0) {
        log(`row ${i}: no OTP input (skipping)`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(400);
        continue;
      }
      const otp = (await readPickupOtp(page)) || processed.find((p) => p.pickupOtp)?.pickupOtp;
      if (!otp) {
        log(`row ${i}: no pickup OTP available`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(400);
        continue;
      }
      await otpInput.fill(otp);
      await shot(`08-pickup-otp-${i}`);
      await page.getByRole("button", { name: "Confirm Pickup" }).first().click();
      await sleep(1200);
      log(`row ${i}: confirmed pickup (OTP ${otp})`);
      await shot(`09-picked-up-${i}`);
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(500);
    }

    await shot("10-final");
    log("DONE");
  } catch (e) {
    log(`FATAL: ${e.message}`);
    await shot("99-error").catch(() => {});
  } finally {
    appendJsonLine("/workspace/qa/output/orders.jsonl", {
      role: "vendor",
      phone,
      processed,
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
