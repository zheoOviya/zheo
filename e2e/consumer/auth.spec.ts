import { test, expect } from "@playwright/test";
import { consumerLogin, consumerSignOut } from "../helpers/consumer";
import { uniquePhone } from "../helpers/constants";

test.describe("consumer authentication", () => {
  test("implicit sign-up with OTP signs the user in", async ({ page }) => {
    await consumerLogin(page, uniquePhone());
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
  });

  test("unauthenticated visitors see sign in / sign up links", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  });

  test("account menu exposes profile, orders, addresses and sign out", async ({
    page,
  }) => {
    await consumerLogin(page, uniquePhone());
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Your profile" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Order history" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Saved addresses" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Sign out" }),
    ).toBeVisible();
  });

  test("sign out returns to the login page", async ({ page }) => {
    await consumerLogin(page, uniquePhone());
    await consumerSignOut(page);
  });
});

test.describe("consumer mobile account drawer", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("account menu renders as a bottom-sheet dialog on mobile", async ({
    page,
  }) => {
    await consumerLogin(page, uniquePhone());
    await page.getByRole("button", { name: "Account menu" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Your profile" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
