import { expect, type Page } from "@playwright/test";

// Vendor console login is phone + OTP. The demo OTP is surfaced on screen as
// "Demo code: XXXXXX" but NOT auto-filled, so the helper reads it from the DOM.
export async function vendorLogin(
  page: Page,
  phone = "+919876000001",
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();

  const demoText = (await page.getByText(/Demo code:/).textContent()) ?? "";
  const otp = demoText.replace(/\D/g, "");

  await page.getByLabel("OTP code").fill(otp);
  await page.getByRole("button", { name: "Verify & sign in" }).click();

  // The AppShell sidebar is the reliable post-login landmark.
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
