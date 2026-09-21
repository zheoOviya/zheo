import { test, expect, type Page } from "@playwright/test";

// A2b-DOT_HITAREA — consumer onboarding carousel dots.
//
// Scope is deliberately narrow: the pagination dots' hit area, selection
// semantics and narrow-viewport layout only. Unlike the rest of the consumer
// suite (which seeds `snakzap_onboarded` to bypass the first-run carousel),
// these specs clear the flag so the onboarding page actually renders.
//
// Geometry is asserted from browser layout (bounding boxes + document
// scrollWidth/clientWidth), never from screenshots.

const VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
] as const;

const TAB_NAMES = [
  "Go to slide 1: Order Ahead",
  "Go to slide 2: Real-Time Alerts",
  "Go to slide 3: No Delivery Fees",
] as const;

async function renderOnboarding(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  // Clear the first-run flag before any app script runs so the OnboardingGate
  // does not bounce the visitor to the home feed.
  await page.addInitScript(() => {
    localStorage.removeItem("snakzap_onboarded");
  });
  await page.goto("/onboarding");
  await expect(page.getByRole("region", { name: "Welcome to SnakZap" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `document scrollWidth ${scrollWidth} must not exceed clientWidth ${clientWidth}`,
  ).toBeLessThanOrEqual(clientWidth);
}

test.describe("consumer onboarding carousel dots", () => {
  test("renders three dots over the visible carousel and selects on click", async ({ page }) => {
    await renderOnboarding(page, 390, 844);

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");

    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  });

  test("exposes one accessible name per dot", async ({ page }) => {
    await renderOnboarding(page, 390, 844);
    for (const name of TAB_NAMES) {
      await expect(page.getByRole("tab", { name })).toBeVisible();
    }
  });

  test("gives every dot a hit box of at least 44x44", async ({ page }) => {
    await renderOnboarding(page, 390, 844);
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      const box = await tabs.nth(i).boundingBox();
      expect(box, `dot ${i + 1} bounding box`).not.toBeNull();
      expect(box?.width ?? 0, `dot ${i + 1} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, `dot ${i + 1} height`).toBeGreaterThanOrEqual(44);
    }
  });

  for (const viewport of VIEWPORTS) {
    test(`does not overflow horizontally at ${viewport.width}px`, async ({ page }) => {
      await renderOnboarding(page, viewport.width, viewport.height);

      // Non-last state: Back + Next on the primary row, dots on their own row.
      await expect(page.getByRole("button", { name: "Next slide" })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      // Last state: Next is replaced by the wider "Get Started" action.
      await page.getByRole("tab").nth(2).click();
      await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
