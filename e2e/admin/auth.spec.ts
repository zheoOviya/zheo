import { test, expect } from "@playwright/test";
import { adminLogin } from "../helpers/admin";
import { SEEDED_ADMIN_EMAIL } from "../helpers/constants";

test.describe("admin authentication", () => {
  test("operator signs in with email OTP and lands on the dashboard", async ({
    page,
  }) => {
    await adminLogin(page, SEEDED_ADMIN_EMAIL);
    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
  });

  test("sign out returns to the admin login page", async ({ page }) => {
    await adminLogin(page, SEEDED_ADMIN_EMAIL);
    // Two sign-out controls exist (sidebar + top header); both clear the
    // session, so target the first available one.
    await page.getByRole("button", { name: /Sign Out/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });
});
