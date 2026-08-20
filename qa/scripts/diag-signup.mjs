import { chromium } from "@playwright/test";

// Diagnostic: reproduce the "Send OTP never enables" issue.
// Navigates to signup, handles onboarding, then repeatedly fills phone and
// reports the DOM/React state so we can see WHY the button stays disabled.

const phone = process.argv[2] || "9880000990";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto("http://localhost:3000/signup", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);
  if (page.url().includes("/onboarding")) {
    console.log("onboarding gate -> skip");
    await page.getByRole("button", { name: "Skip" }).click().catch(() => {});
    await sleep(1500);
    await page.goto("http://localhost:3000/signup", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1000);
  }

  const reactKeys = await page.evaluate(() => {
    const el = document.querySelector("#phone-input");
    return el ? Object.keys(el).filter((k) => k.startsWith("__react")) : "NO_INPUT";
  });
  console.log("react keys on input:", JSON.stringify(reactKeys));

  for (let i = 0; i < 8; i++) {
    await page.fill("#phone-input", phone).catch((e) => console.log(`fill err: ${e.message.split("\n")[0]}`));
    await sleep(800);
    const state = await page.evaluate(() => {
      const el = document.querySelector("#phone-input");
      const btn = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "Send OTP");
      const reactKeys = el ? Object.keys(el).filter((k) => k.startsWith("__react")) : [];
      return {
        inputValue: el ? el.value : null,
        btnDisabled: btn ? btn.disabled : "NO_BTN",
        reactKeys,
      };
    });
    console.log(`iter ${i}:`, JSON.stringify(state));
    if (state.btnDisabled === false) {
      console.log("BUTTON ENABLED");
      break;
    }
  }

  // Also dump any visible error text on the form
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log("body snippet:", bodyText.slice(0, 400).replace(/\n/g, " | "));
} catch (e) {
  console.log("DIAG FATAL:", e.message);
} finally {
  await browser.close();
}
