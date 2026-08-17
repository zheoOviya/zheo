import { chromium } from "@playwright/test";
import {
  CONSUMER,
  setupDirs,
  makeLogger,
  newAuditedPage,
  appendJsonLine,
} from "./lib.mjs";

// Customer QA agent: human-like signup -> browse -> order (COD) -> track.
// Polls the live tracking page (reload-based) so it can capture the status
// advancing to READY_FOR_PICKUP / PICKED_UP while the vendor agent works.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  }),
);

const phone = args.phone || "9880000501";
const restaurant = args.restaurant || "Biryani House";
const items = (args.items || "Chicken Biryani").split(",").map((s) => s.trim()).filter(Boolean);
const qty = Number(args.qty || 1);
const pollMs = Number(args.poll || 120000);

const { shots, logFile } = setupDirs("customer", phone);
const log = makeLogger(logFile, `consumer:${phone}`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(promise, label, timeout = 20000) {
  try {
    await promise;
  } catch (e) {
    log(`WAIT_FAIL ${label}: ${e.message.split("\n")[0]}`);
    throw e;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const { page, issues, shot } = await newAuditedPage(browser, {
    viewport: { width: 390, height: 844 },
    log,
    shots,
    prefix: phone,
  });

  // Pre-seed onboarding so the first-run gate does not bounce us to /onboarding.
  // (Logged separately as a product finding: new visitors hit /onboarding even
  // when they navigate directly to /signup.)
  await page.addInitScript(() => {
    try {
      localStorage.setItem("snakzap_onboarded", "1");
    } catch {}
  });

  const started = Date.now();
  let orderId = null;
  const findings = [];

  async function sendOtpReliable(page, phone, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await page.fill("#phone-input", phone).catch(() => {});
      await sleep(400);
      const enabled = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "Send OTP");
        return !!b && !b.disabled;
      });
      if (!enabled) continue;
      try {
        await page.getByRole("button", { name: "Send OTP" }).click({ timeout: 3000 });
      } catch {
        continue;
      }
      try {
        await page.getByTestId("demo-otp").waitFor({ timeout: 8000 });
        return true;
      } catch {
        const otpInputs = await page.locator('input[placeholder="000000"]').count();
        if (otpInputs > 0) return true; // OTP step reached (no demo code)
        continue;
      }
    }
    return false;
  }

  async function clickOrForce(locator, label, timeout = 2000) {
    try {
      await locator.first().click({ timeout });
    } catch (e) {
      const msg = `blocked-by-bottom-nav: ${label}`;
      if (!findings.includes(msg)) findings.push(msg);
      log(`ISSUE(${msg}): falling back to JS click`);
      await locator.first().evaluate((el) => el.click());
    }
  }

  try {
    // 0. First-run onboarding gate (bounces new visitors to /onboarding)
    log("STEP first-run landing");
    await page.goto(`${CONSUMER}/signup`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    if (page.url().includes("/onboarding")) {
      log("redirected to /onboarding (first-run gate)");
      await shot("00-onboarding");
      await page.getByRole("button", { name: "Skip" }).click().catch(() => {});
      await waitFor(
        page.waitForURL((u) => u.pathname !== "/onboarding", { timeout: 15000 }),
        "skip onboarding",
      ).catch(() => log("onboarding skip: still on /onboarding"));
      await page.goto(`${CONSUMER}/signup`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(800);
    }

    // 1. Signup
    log(`STEP signup: ${phone}`);
    const sent = await sendOtpReliable(page, phone);
    await shot("01-signup-form");
    if (!sent) throw new Error("Send OTP flow did not complete");
    log("OTP auto-filled");
    await shot("02-otp-autofilled");
    await page.getByRole("button", { name: "Create Account" }).click();
    await waitFor(
      page.waitForURL((u) => u.pathname === "/" || u.pathname === "/onboarding", { timeout: 20000 }),
      "post-login nav",
    );

    // 2. Onboarding gate (first run)
    if (page.url().includes("/onboarding")) {
      log("STEP onboarding");
      await shot("03-onboarding");
      await page.getByRole("button", { name: "Skip" }).click().catch(() => {});
      await waitFor(
        page.waitForURL((u) => u.pathname !== "/onboarding", { timeout: 15000 }),
        "skip onboarding",
      ).catch(() => log("onboarding skip: still on /onboarding (continuing)"));
    }
    await sleep(800);
    await shot("04-home");

    // 3. Browse -> restaurant menu
    log(`STEP browse: ${restaurant}`);
    const card = page.locator('a[href^="/restaurants/"]', { hasText: restaurant }).first();
    await waitFor(card.waitFor({ timeout: 15000 }), "restaurant card");
    await card.click();
    await waitFor(page.waitForURL(/\/restaurants\//, { timeout: 15000 }), "menu nav");
    await shot("05-menu");

    // 4. Add items
    for (const item of items) {
      log(`STEP add item: ${item}`);
      const addBtn = page.getByRole("button", { name: new RegExp(`^Add ${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
      const found = await addBtn.count();
      if (found === 0) {
        log(`WARN item not found: ${item} (using first Add +)`);
        const firstAdd = page.getByRole("button", { name: /Add .+/ }).first();
        await firstAdd.click();
      } else {
        await addBtn.first().click();
      }
      await waitFor(page.getByRole("dialog").waitFor({ timeout: 10000 }), "picker");
      await shot(`06-picker-${item}`);
      await clickOrForce(page.getByRole("button", { name: /Add to Cart/ }), "picker-add-to-cart");
      await waitFor(
        page.getByRole("button", { name: /View cart/ }).waitFor({ timeout: 12000 }),
        "view cart bar",
      );
    }

    // 5. Quantity bump (if requested)
    if (qty > 1) {
      log(`STEP quantity bump x${qty}`);
      await clickOrForce(page.getByRole("button", { name: /View cart/ }), "view-cart-bar");
      await waitFor(page.getByRole("dialog", { name: "Your cart" }).waitFor({ timeout: 10000 }), "cart drawer");
      for (let i = 1; i < qty; i++) {
        await page.getByRole("button", { name: "Increase quantity" }).first().click();
        await sleep(250);
      }
      await shot("07-cart");
      await clickOrForce(page.getByRole("button", { name: /Place Order/ }), "drawer-place-order");
    } else {
      await clickOrForce(page.getByRole("button", { name: /View cart/ }), "view-cart-bar");
      await waitFor(page.getByRole("dialog", { name: "Your cart" }).waitFor({ timeout: 10000 }), "cart drawer");
      await shot("07-cart");
      await clickOrForce(page.getByRole("button", { name: /Place Order/ }), "drawer-place-order");
    }

    // 6. Checkout -> COD -> place order
    await waitFor(page.waitForURL(/\/checkout/, { timeout: 15000 }), "checkout nav");
    await shot("08-checkout");
    await page.getByRole("radio", { name: /Cash on Pickup/ }).click();
    await shot("09-cod-selected");
    await page.getByRole("button", { name: /Place Pickup Order/ }).click();
    await waitFor(page.getByText("Order Confirmed!").waitFor({ timeout: 20000 }), "order confirmed");
    await shot("10-order-confirmed");

    const trackLink = page.locator('a[href*="/orders/"]').first();
    if (await trackLink.count()) {
      const href = await trackLink.getAttribute("href");
      orderId = href.split("/").pop();
      log(`ORDER_PLACED: ${orderId} (restaurant=${restaurant}, items=${items.join("+")}, qty=${qty})`);
    } else {
      log("WARN no track link found on success page");
    }

    // 7. Track order + poll status
    if (orderId) {
      log(`STEP track: ${orderId}`);
      await page.goto(`${CONSUMER}/orders/${orderId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitFor(page.getByText("Order Status").waitFor({ timeout: 20000 }), "order status page");
      await sleep(1500);
      await shot("11-track-confirmed");

      const seen = new Set();
      const deadline = Date.now() + pollMs;
      let finalStatus = "CONFIRMED";
      const statusLabelToKey = {
        Confirmed: "CONFIRMED",
        Preparing: "PREPARING",
        "Almost Ready": "ALMOST_READY",
        Ready: "READY_FOR_PICKUP",
        "Picked Up": "PICKED_UP",
      };
      while (Date.now() < deadline) {
        const body = await page.evaluate(() => document.body.innerText);
        let stage;
        if (body.includes("Order Picked Up!")) {
          stage = "PICKED_UP";
        } else if (body.includes("Show this at the counter")) {
          stage = "READY_FOR_PICKUP";
        } else {
          const label = await page
            .evaluate(() => {
              const spans = Array.from(document.querySelectorAll("span"));
              const inProg = spans.find((s) => (s.textContent || "").trim() === "In progress");
              if (!inProg) return null;
              const block = inProg.closest(".flex-1");
              const p = block ? block.querySelector("p") : null;
              return p ? (p.textContent || "").trim() : null;
            })
            .catch(() => null);
          stage = statusLabelToKey[label] ?? "CONFIRMED";
        }

        finalStatus = stage;
        if (!seen.has(stage)) {
          seen.add(stage);
          log(`STATUS: ${stage}`);
          await shot(`12-track-${stage.toLowerCase()}`);
        }
        if (stage === "PICKED_UP") break;
        await sleep(4000);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(800);
      }
      log(`FINAL_STATUS: ${finalStatus} (${Math.round((Date.now() - started) / 1000)}s elapsed)`);
      await shot("13-final");
    }

    log("DONE");
  } catch (e) {
    log(`FATAL: ${e.message}`);
    await shot("99-error").catch(() => {});
  } finally {
    appendJsonLine("/workspace/qa/output/orders.jsonl", {
      role: "customer",
      phone,
      restaurant,
      items,
      qty,
      orderId,
      issues,
      findings,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    });
    log(`ISSUES_COUNT: ${issues.length}`);
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
