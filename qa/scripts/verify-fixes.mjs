import { chromium } from "@playwright/test";

const CONSUMER = "http://localhost:3000";
const RESTAURANT_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_URL = `${CONSUMER}/restaurants/${RESTAURANT_ID}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
  } catch (e) {
    // fall through; page may have committed but not reached "load"
  }
  await sleep(1500);
}

function boxInfo(b) {
  return b ? `x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}` : "null";
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const errors = [];

  // ---- Fix 2: OnboardingGate allowlist (fresh context, no seed) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    await goto(page, `${CONSUMER}/signup`);
    const signupUrl = page.url();
    results.push({ check: "signup stays on /signup", url: signupUrl, pass: signupUrl.includes("/signup") });

    await goto(page, `${CONSUMER}/login`);
    const loginUrl = page.url();
    results.push({ check: "login stays on /login", url: loginUrl, pass: loginUrl.includes("/login") });

    await goto(page, `${CONSUMER}/`);
    const rootUrl = page.url();
    results.push({ check: "root bounces to /onboarding", url: rootUrl, pass: rootUrl.includes("/onboarding") });

    await ctx.close();
  }

  // ---- Fix 1: menu page View Cart bar + drawer overlay ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem("snakzap_onboarded", "1"); } catch {}
    });

    await goto(page, MENU_URL);
    await sleep(1000);

    const addBtn = page.getByRole("button", { name: "Add Chicken Biryani" });
    const addCount = await addBtn.count();
    results.push({ check: "menu add button present", pass: addCount > 0 });

    if (addCount > 0) {
      await addBtn.first().click();
      await sleep(600);

      // Picker should be above nav (z-[60]). Verify Add to Cart button is clickable.
      const addToCart = page.getByRole("button", { name: /Add to Cart/ });
      const atcCount = await addToCart.count();
      results.push({ check: "picker Add to Cart present", pass: atcCount > 0 });

      if (atcCount > 0) {
        // elementFromPoint at Add to Cart center should not be the nav.
        const hit = await addToCart.first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const top = document.elementFromPoint(cx, cy);
          return { cx, cy, topTag: top?.tagName, topCls: top?.className || "" };
        });
        results.push({ check: "Add to Cart hit-test (not blocked)", pass: hit.topTag === "BUTTON", detail: JSON.stringify(hit) });

        await addToCart.first().click();
        await sleep(1600); // wait for ADD_PROCESSING + success + close
      }

      // View Cart bar should now be visible and ABOVE the nav (no vertical overlap).
      const viewCart = page.getByRole("button", { name: /View cart/ });
      const vcCount = await viewCart.count();
      results.push({ check: "View Cart bar present after add", pass: vcCount > 0 });

      const geom = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Primary"]');
        const vc = Array.from(document.querySelectorAll("button")).find((b) => /View cart/i.test(b.getAttribute("aria-label") || ""));
        if (!nav || !vc) return null;
        const nr = nav.getBoundingClientRect();
        const vr = vc.getBoundingClientRect();
        const overlap = !(vr.bottom <= nr.top || vr.top >= nr.bottom);
        return { navTop: nr.top, navBottom: nr.bottom, vcTop: vr.top, vcBottom: vr.bottom, overlap };
      });
      if (geom) {
        results.push({
          check: "View Cart bar does not overlap nav",
          pass: !geom.overlap && geom.vcBottom <= geom.navTop,
          detail: JSON.stringify(geom),
        });
      } else {
        results.push({ check: "View Cart bar does not overlap nav", pass: false, detail: "geometry null" });
      }

      if (vcCount > 0) {
        await viewCart.first().click();
        await sleep(800);

        const placeOrder = page.getByRole("button", { name: /Place Order/ });
        const poCount = await placeOrder.count();
        results.push({ check: "CartDrawer Place Order present", pass: poCount > 0 });

        if (poCount > 0) {
          const hit2 = await placeOrder.first().evaluate((el) => {
            const r = el.getBoundingClientRect();
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            const top = document.elementFromPoint(cx, cy);
            return { cx, cy, topTag: top?.tagName, topText: top?.textContent?.trim().slice(0, 40) || "" };
          });
          results.push({ check: "Place Order hit-test (not blocked by nav)", pass: hit2.topTag === "BUTTON", detail: JSON.stringify(hit2) });
        }
      }
    }

    await ctx.close();
  }

  await browser.close();

  console.log("===== VERIFICATION RESULTS =====");
  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.check}${r.detail ? " | " + r.detail : ""}${r.url ? " | url=" + r.url : ""}`);
  }
  console.log(`===== OVERALL: ${allPass ? "ALL PASS" : "SOME FAILED"} =====`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFY_ERROR", e);
  process.exit(2);
});
