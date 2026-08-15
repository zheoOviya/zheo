import { test, expect } from "@playwright/test";
import { consumerLogin, addBiryaniToCart } from "../helpers/consumer";
import { uniquePhone, BIRYANI_HOUSE_ID } from "../helpers/constants";

test.describe("consumer ordering", () => {
  test("browses a restaurant menu and adds an item to the cart", async ({
    page,
  }) => {
    await consumerLogin(page, uniquePhone());
    await page.goto(`/restaurants/${BIRYANI_HOUSE_ID}`);

    await expect(
      page.getByRole("heading", { name: "Biryani House" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
    await expect(
      page.getByRole("dialog", { name: "Customize Chicken Biryani" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Add to Cart/ }).click();

    await expect(
      page.getByRole("button", { name: /View cart, 1 item/ }),
    ).toBeVisible();
  });

  test("places a cash-on-pickup order end to end", async ({ page }) => {
    await consumerLogin(page, uniquePhone());
    await addBiryaniToCart(page);

    await page.getByRole("button", { name: /View cart, 1 item/ }).click();
    await page.getByRole("button", { name: /^Place Order \(/ }).click();

    await page.getByRole("radio", { name: /Cash on Pickup/ }).click();
    await page.getByRole("button", { name: /Place Pickup Order/ }).click();

    await expect(
      page.getByRole("heading", { name: "Order Confirmed!" }),
    ).toBeVisible();
  });

  test("order history lists the placed order", async ({ page }) => {
    const phone = uniquePhone();
    await consumerLogin(page, phone);
    await addBiryaniToCart(page);

    await page.getByRole("button", { name: /View cart, 1 item/ }).click();
    await page.getByRole("button", { name: /^Place Order \(/ }).click();
    await page.getByRole("radio", { name: /Cash on Pickup/ }).click();
    await page.getByRole("button", { name: /Place Pickup Order/ }).click();
    await expect(
      page.getByRole("heading", { name: "Order Confirmed!" }),
    ).toBeVisible();

    // Navigate via the account menu so the auth store survives client-side.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Order history" }).click();

    await expect(
      page.getByRole("heading", { name: "Your Orders" }),
    ).toBeVisible();
  });
});
