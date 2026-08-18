import { expect, type Page } from "@playwright/test";
import { BIRYANI_HOUSE_ID } from "./constants";

// Consumer login is implicit sign-up: the first "Send OTP" for an unknown phone
// creates the account. In the dev/preview build the OTP is auto-filled into the
// OTP input, so the flow is: fill phone -> Send OTP -> Verify & Sign In.
export async function consumerLogin(
  page: Page,
  phone = "9876500001",
): Promise<void> {
  // The first-run OnboardingGate redirects any visitor without the completion
  // flag to /onboarding. Seed it before navigation so login lands on the home
  // page (which carries the account menu) instead of the intro carousel.
  await page.addInitScript(() => {
    localStorage.setItem("snakzap_onboarded", "1");
  });
  await page.goto("/login");
  await page.locator("#phone-input").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();

  const verify = page.getByRole("button", { name: "Verify & Sign In" });
  await expect(verify).toBeEnabled();
  await verify.click();

  // Post-login redirect lands on the home page whose header carries the
  // account menu regardless of restaurant data.
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

export async function consumerSignOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

// Adds a single Chicken Biryani to the cart on the Biryani House menu.
export async function addBiryaniToCart(page: Page): Promise<void> {
  await page.goto(`/restaurants/${BIRYANI_HOUSE_ID}`);
  await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
  await page
    .getByRole("dialog", { name: "Customize Chicken Biryani" })
    .getByRole("button", { name: /Add to Cart/ })
    .click();
  await expect(
    page.getByRole("button", { name: /View cart, 1 item/ }),
  ).toBeVisible();
}
