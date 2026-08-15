import { test, expect } from "@playwright/test";
import { consumerLogin } from "../helpers/consumer";
import { uniquePhone } from "../helpers/constants";

test.describe("consumer profile", () => {
  test("shows the profile sections after sign-in", async ({ page }) => {
    await consumerLogin(page, uniquePhone());
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: "My Account" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Spice Profile" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Wallet & Rewards" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Refer & Earn" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "VIP Customer Support" }),
    ).toBeVisible();
  });

  test("sets a spice preference and reflects it in the badge", async ({
    page,
  }) => {
    await consumerLogin(page, uniquePhone());
    await page.goto("/profile");

    await page
      .getByRole("button", { name: "Spice level 4: Fiery" })
      .click();

    // The summary badge updates from "Not set" to the selected label.
    await expect(page.getByText("Fiery", { exact: true })).toBeVisible();
  });

  test("reassures standard support remains available outside VIP", async ({
    page,
  }) => {
    await consumerLogin(page, uniquePhone());
    await page.goto("/profile");

    // The VIP card always explains that standard support is still available.
    const vipCard = page.getByRole("heading", { name: "VIP Customer Support" });
    await expect(vipCard).toBeVisible();
    await expect(
      page.getByText(/Standard support is always available/),
    ).toBeVisible();
  });
});
