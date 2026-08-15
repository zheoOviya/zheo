import { test, expect } from "@playwright/test";
import { consumerLogin, addBiryaniToCart } from "../helpers/consumer";
import { vendorLogin } from "../helpers/vendor";
import { adminLogin } from "../helpers/admin";
import { uniquePhone, CONSUMER_URL, VENDOR_URL, ADMIN_URL } from "../helpers/constants";

// End-to-end lifecycle across all three consoles sharing one API process:
//   1. a consumer places a COD order,
//   2. the vendor sees that order in their console,
//   3. an admin suspends the consumer,
//   4. the consumer sees the suspension banner on their next visit.
test.describe("cross-agent lifecycle", () => {
  test("consumer order -> vendor visibility -> admin suspension -> consumer banner", async ({
    browser,
  }) => {
    const phone = uniquePhone();

    // 1. Consumer: sign in and place a cash-on-pickup order.
    const consumerContext = await browser.newContext({ baseURL: CONSUMER_URL });
    const consumer = await consumerContext.newPage();
    await consumerLogin(consumer, phone);
    await addBiryaniToCart(consumer);
    await consumer.getByRole("button", { name: /View cart, 1 item/ }).click();
    await consumer.getByRole("button", { name: /^Place Order \(/ }).click();
    await consumer.getByRole("radio", { name: /Cash on Pickup/ }).click();
    await consumer.getByRole("button", { name: /Place Pickup Order/ }).click();
    await expect(
      consumer.getByRole("heading", { name: "Order Confirmed!" }),
    ).toBeVisible();

    const orderRef = (await consumer.getByText(/^Order #/).textContent()) ?? "";
    // Consumer shows the last 6 hex chars; vendor shows the last 4. Both are
    // uppercase hex, so strip everything else and take the shared 4-char tail.
    const orderShort = orderRef.replace(/[^0-9A-Z]/g, "").slice(-4);

    // 2. Vendor: the order appears in the orders list.
    const vendorContext = await browser.newContext({ baseURL: VENDOR_URL });
    const vendor = await vendorContext.newPage();
    await vendorLogin(vendor);
    await vendor.goto("/orders");
    await expect(
      vendor.getByRole("heading", { name: "Orders" }),
    ).toBeVisible();
    await expect(vendor.getByText(`#${orderShort}`)).toBeVisible();

    // 3. Admin: locate the consumer by phone and suspend them.
    const adminContext = await browser.newContext({ baseURL: ADMIN_URL });
    const admin = await adminContext.newPage();
    await adminLogin(admin);
    await admin.goto("/users");
    await admin.getByPlaceholder("Search by phone...").fill(phone);
    await admin.getByRole("button", { name: "Search" }).click();
    await admin.getByRole("button", { name: "Suspend" }).first().click();
    await expect(admin.getByText("Suspended", { exact: true })).toBeVisible();

    // 4. Consumer: the suspension banner shows on the next visit.
    await consumer.goto("/");
    await expect(
      consumer.getByText(/Your account has been suspended/),
    ).toBeVisible();

    await consumerContext.close();
    await vendorContext.close();
    await adminContext.close();
  });
});
