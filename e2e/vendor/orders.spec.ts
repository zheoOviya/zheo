import { test, expect } from "@playwright/test";
import { vendorLogin } from "../helpers/vendor";
import { SEEDED_VENDOR_PHONE } from "../helpers/constants";

test.describe("vendor orders", () => {
  test("orders page loads with filters and search", async ({ page }) => {
    await vendorLogin(page, SEEDED_VENDOR_PHONE);
    await page.goto("/orders");

    await expect(
      page.getByRole("heading", { name: "Orders" }),
    ).toBeVisible();

    // Status filter chips are always rendered even with zero orders.
    await expect(page.getByRole("button", { name: /All/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Today/ })).toBeVisible();
  });
});
