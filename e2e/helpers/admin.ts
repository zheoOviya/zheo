import { expect, type Page } from "@playwright/test";

// Admin console login is email -> OTP -> (optional TOTP). Seeded demo admins
// have TOTP disabled, so the flow lands directly on the dashboard after OTP.
// The OTP is auto-filled in the preview build.
export async function adminLogin(
  page: Page,
  email = "admin@snakzap.dev",
): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("admin@snakzap.dev").fill(email);
  await page.getByRole("button", { name: "Send OTP" }).click();

  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeEnabled();
  await cont.click();

  await expect(
    page.getByRole("heading", { name: "Dashboard" }),
  ).toBeVisible();
}
