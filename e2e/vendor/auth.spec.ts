import { test, expect } from "@playwright/test";
import { vendorLogin } from "../helpers/vendor";
import { SEEDED_VENDOR_PHONE } from "../helpers/constants";

test.describe("vendor authentication", () => {
  test("chain owner signs in with OTP and lands on the dashboard", async ({
    page,
  }) => {
    await vendorLogin(page, SEEDED_VENDOR_PHONE);
    await expect(
      page.getByRole("heading", { name: "Overview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main" }),
    ).toBeVisible();
  });

  test("sign out returns to the vendor login page", async ({ page }) => {
    await vendorLogin(page, SEEDED_VENDOR_PHONE);
    await page.getByRole("button", { name: /Sign out/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
