import { test, expect } from "@playwright/test";
import { adminLogin } from "../helpers/admin";
import { SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_PHONE } from "../helpers/constants";

test.describe("admin user management", () => {
  test("searches users by phone and shows a result", async ({ page }) => {
    await adminLogin(page, SEEDED_ADMIN_EMAIL);
    await page.goto("/users");

    await expect(
      page.getByRole("heading", { name: "Users" }),
    ).toBeVisible();

    await page.getByPlaceholder("Search by phone...").fill(SEEDED_ADMIN_PHONE);
    await page.getByRole("button", { name: "Search" }).click();

    // The seeded admin phone resolves to exactly one row.
    await expect(page.getByRole("link", { name: SEEDED_ADMIN_PHONE })).toBeVisible();
    await expect(page.getByText("ADMIN", { exact: true }).first()).toBeVisible();
  });
});
