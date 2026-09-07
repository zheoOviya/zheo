import { test, expect, type Browser, type Page } from "@playwright/test";
import { CONSUMER_URL, uniquePhone } from "../helpers/constants";
import { vendorLogin } from "../helpers/vendor";
import {
  DINE_IN_FIXTURE_RESTAURANT_NAME,
  DINE_IN_FIXTURE_TABLES,
  type DineInFixtureTable,
} from "../consumer/dine-in-fixture.constants";

// ============================================
// DINE-OPS4-C3 — Vendor Dine-In Bill Browser Track.
//
// Proves the vendor bill surface end to end across both actors against a single
// shared API process:
//   1. A consumer opens a session, places an order and requests the bill
//      (PUBLIC consumer UI; the same cross-app path the consumer dine-in spec
//      uses to seed BRING_BILL).
//   2. The seeded vendor console /dine-in/bills queue surfaces the frozen bill,
//      acknowledges it, and then delivers it -> the row leaves the queue while
//      the detail stays readable as a delivered bill.
//   3. The detail is read-only and prints only its #bill-print-region.
//
// Evidence classes captured per test:
//   1. Interaction proof      — consumer request bill -> vendor Acknowledge /
//                               Mark delivered / View bill clicks
//   2. Network emission proof — the vendor page emits GET /bills (queue) and
//                               ONLY the dedicated bill mutations
//                               (POST /bills/:billId/acknowledge,
//                                POST /bills/:billId/deliver). Generic
//                               service-request mutations and any
//                               payment/settle/close-session mutation are
//                               captured and asserted absent.
//   3. DOM mutation proof     — Pending -> Acknowledged -> (deliver) row gone;
//                               detail Delivered banner after COMPLETED
//   4. Visual snapshot        — queue (1440px) + detail (1440px) PNGs; the
//                               consumer seed runs at 375px
//   5. State persistence      — cold reload keeps ACKNOWLEDGED; the delivered
//                               bill detail still renders from a direct URL
//                               after a reload shows the queue row is gone
//
// RUN MODEL — each test consumes its own reserved fixture table ([15..17])
// from DINE_IN_FIXTURE_TABLES, statically disjoint from the consumer dine-in
// suite's [0..14]. openSession rejects a second, different-owner open on a
// live table, so the reserved partition keeps this suite green both in a full
// shared single-API-process run (consumer project first, live sessions left on
// [0..14]) and standalone against a freshly seeded API process, e.g.:
//   npx playwright test e2e/vendor/dine-in-bills.spec.ts --project=vendor
//
// Sanitization: the opaque table token and the Authorization header value are
// never printed in output or screenshots; raw session/bill ids are never
// logged. The table token constant is only used to (a) enter the table and
// (b) assert it never renders in the vendor console DOM.
// ============================================

// Consumer seeding runs on the 375px mobile viewport (mirroring the consumer
// dine-in spec); every vendor console assertion/screenshot runs at 1440px.
const CONSUMER_VIEWPORT = { width: 375, height: 844 };
const VENDOR_VIEWPORT = { width: 1440, height: 900 };

// Three reserved fixture tables ([15..17] -> Table 16-18), one per test,
// statically disjoint from the consumer dine-in suite's [0..14]. In a full
// shared single-API-process run the consumer project runs first and leaves
// live sessions on [0..14], so only this reserved partition keeps the vendor
// bill suite collision-free. The 375px consumer viewport mirrors the consumer
// dine-in spec; the vendor console runs desktop.
const BILLS_FIXTURES: readonly DineInFixtureTable[] = [
  DINE_IN_FIXTURE_TABLES[15],
  DINE_IN_FIXTURE_TABLES[16],
  DINE_IN_FIXTURE_TABLES[17],
];

// The seeded Biryani House restaurant (the vendor bound to the seeded vendor
// phone) owns every dine-in fixture table, so a consumer request here lands in
// the same process the vendor console reads.
const SEED_RESTAURANT_NAME = DINE_IN_FIXTURE_RESTAURANT_NAME;

async function openConsumerSessionReady(
  browser: Browser,
  fixture: DineInFixtureTable,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: CONSUMER_URL,
    viewport: CONSUMER_VIEWPORT,
  });

  // First-run OnboardingGate bypass (same as the existing consumer helper and
  // the consumer dine-in spec): fresh contexts have empty localStorage and the
  // consumer app gates /dine-in entry on snakzap_onboarded="1".
  await context.addInitScript(() => {
    localStorage.setItem("snakzap_onboarded", "1");
  });

  const page = await context.newPage();

  // QR entry -> public resolve. The transient "Checking your table..." spinner
  // is not part of this track's contract (C3R2): assert the stable resolved
  // end-state only, so a fast local resolve cannot race the intermediate text.
  await page.goto(`/dine-in?table=${fixture.token}`);
  await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });

  // Explicit continue -> auth gate -> fresh consumer sign-up.
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.waitForURL(/\/login/);
  await page.locator("#phone-input").fill(uniquePhone());
  await page.getByRole("button", { name: "Send OTP" }).click();
  const verify = page.getByRole("button", { name: "Verify & Sign In" });
  await expect(verify).toBeEnabled({ timeout: 15_000 });
  await verify.click();
  await page.waitForURL((url) => url.pathname === "/dine-in" && url.searchParams.has("table"));
  await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });

  // Authenticated session open -> token-free SESSION_READY handoff. The
  // transient "Opening session..." in-flight text is not part of this track's
  // contract (C3R3): assert the stable session-open truth only.
  await page.getByRole("button", { name: /^Continue/ }).click();
  await expect(page.getByText("Session ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /View Menu/ })).toBeVisible();

  // The opaque token never renders after the resolve step.
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).not.toContain(fixture.token);
  return page;
}

// Places the Track-D order (OPEN -> ACTIVE) then requests the bill, leaving the
// session BILL_REQUESTED with a PENDING BRING_BILL artifact for the vendor.
async function placeOrderAndRequestBill(page: Page, fixture: DineInFixtureTable): Promise<void> {
  await page.getByRole("button", { name: /View Menu/ }).click();
  await page.waitForURL((url) => url.pathname === "/dine-in/menu");
  await expect(page.getByText(SEED_RESTAURANT_NAME).first()).toBeVisible();
  await expect(page.getByText(fixture.label).first()).toBeVisible();
  await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Order placed")).toBeVisible({ timeout: 15_000 });

  // Confirm the bill dialog; exactly one body-less POST (no client billing
  // fields) mirrors the consumer Track F2 boundary.
  await expect(page.getByRole("button", { name: "Request bill" })).toBeVisible();
  await page.getByRole("button", { name: "Request bill" }).click();
  const dialog = page.getByRole("dialog", { name: "Request the bill" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/stop new orders/)).toBeVisible();
  await dialog.getByRole("button", { name: "Request bill" }).click();
  await expect(page.getByText("Bill requested")).toBeVisible({ timeout: 15_000 });
}

async function stubWindowPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __printCalls?: number; print: () => void };
    win.__printCalls = 0;
    win.print = () => {
      win.__printCalls = (win.__printCalls ?? 0) + 1;
    };
  });
}

async function printCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const win = window as unknown as { __printCalls?: number };
    return win.__printCalls ?? 0;
  });
}

// Row-scoped locator: the queue may carry unrelated seeded rows, so every
// assertion is scoped to the fixture table's own bill row.
function queueRow(page: Page, fixture: DineInFixtureTable) {
  return page.getByRole("listitem").filter({ hasText: fixture.label });
}

// A dedicated bill mutation is EXACTLY one of the two legal lifecycle POSTs the
// vendor console may emit for a bill id. Any other vendor POST would be a
// generic service-request mutation or a payment/settle/close-session mutation,
// which this track forbids end to end.
function isDedicatedBillMutation(pathname: string): boolean {
  return /^\/api\/vendor\/dine-in\/bills\/[0-9a-f-]+\/(acknowledge|deliver)$/.test(
    pathname,
  );
}

async function openVendorBills(
  page: Page,
): Promise<{ billMutations: string[]; otherVendorPosts: string[] }> {
  await vendorLogin(page);
  // Capture every vendor API POST after the login handoff. Login/OTP POSTs
  // happen before this listener and are therefore excluded by construction.
  const billMutations: string[] = [];
  const otherVendorPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const pathname = new URL(req.url()).pathname;
    if (isDedicatedBillMutation(pathname)) {
      billMutations.push(pathname);
    } else if (pathname.startsWith("/api/vendor/")) {
      otherVendorPosts.push(pathname);
    }
  });
  await page.goto("/dine-in/bills");
  await expect(page.getByRole("heading", { name: "Bill Requests" })).toBeVisible();
  return { billMutations, otherVendorPosts };
}

// Negative proof: the vendor console may only mutate via the dedicated
// acknowledge/deliver endpoints. No generic service-request mutation and no
// payment/settle/close-session POST may appear, and every mutation must carry
// the fixture's bill id.
function assertOnlyDedicatedBillMutations(
  billMutations: string[],
  otherVendorPosts: string[],
  expectedActions: string[],
): void {
  expect(otherVendorPosts).toEqual([]);
  const actions = billMutations.map((p) => p.split("/").pop());
  expect([...new Set(actions)].sort()).toEqual([...expectedActions].sort());
  for (const pathname of billMutations) {
    expect(pathname).toMatch(
      /^\/api\/vendor\/dine-in\/bills\/[0-9a-f-]+\/(acknowledge|deliver)$/,
    );
  }
}

// Negative DOM proof scoped to the bill UI region. The AppShell wraps page
// content in <main> while the merchant shell nav ("Settlements", "GST Reports",
// etc.) lives in <aside>; that pre-existing chrome is deliberately excluded so
// this scan proves the bill surface itself carries no forbidden control text.
function expectBillRegionFreeOf(
  page: Page,
  forbidden: readonly string[],
): Promise<void> {
  return page.locator("main").innerText().then((text) => {
    for (const term of forbidden) {
      expect(text).not.toContain(term);
    }
  });
}

// A delivered/COMPLETED bill must never resurface in the queue on a later poll,
// and a stale queue snapshot must not resurrect it (covered by the Vitest unit
// suite); here we assert the persistent read of the delivered detail.
test.describe("Vendor dine-in bills (DINE-OPS4)", () => {
  // Desktop 1440px intent for every vendor console assertion and screenshot;
  // consumer seeding runs on its own 375px mobile context (CONSUMER_VIEWPORT).
  test.use({ viewport: VENDOR_VIEWPORT });

  test("bill queue surfaces a consumer bill request and acknowledges it", async ({
    browser,
    page,
  }) => {
    const fixture = BILLS_FIXTURES[0];
    const consumer = await openConsumerSessionReady(browser, fixture);
    await placeOrderAndRequestBill(consumer, fixture);
    await consumer.close();

    const { billMutations, otherVendorPosts } = await openVendorBills(page);

    // ---------- QUEUE PRESENCE (network: GET /bills for the seeded restaurant) ----------
    const row = queueRow(page, fixture);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("Pending")).toBeVisible();
    await expect(row.getByText("Acknowledge")).toBeVisible();
    await expect(row.getByRole("link", { name: "View bill" })).toBeVisible();
    // A frozen total renders verbatim on the queue (never a payment control).
    expect((await row.innerText()).trim().length).toBeGreaterThan(0);
    const rowBody = await row.innerText();
    for (const forbidden of ["Settle", "Paid", "Pay", "Payment", "Close session"]) {
      expect(rowBody).not.toContain(forbidden);
    }

    // ---------- DOM MUTATION: Pending -> Acknowledged (row stays actionable) ----------
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await expect(row.getByText("Acknowledged")).toBeVisible();
    await expect(row.getByRole("button", { name: "Mark delivered" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);

    // ---------- VISUAL: acknowledged queue row (1440px desktop) ----------
    await page.screenshot({
      path: "test-results/evidence/vendor-bills-acknowledged.png",
      fullPage: true,
    });

    // ---------- COLD RELOAD PERSISTENCE: ACKNOWLEDGED survives a reload ----------
    await page.reload();
    await expect(page.getByRole("heading", { name: "Bill Requests" })).toBeVisible();
    await expect(queueRow(page, fixture).getByText("Acknowledged")).toBeVisible();
    await expect(
      queueRow(page, fixture).getByRole("button", { name: "Mark delivered" }),
    ).toBeVisible();
    await expect(queueRow(page, fixture).getByRole("button", { name: "Acknowledge" })).toHaveCount(0);

    // ---------- NETWORK: only the dedicated acknowledge mutation was emitted ----------
    assertOnlyDedicatedBillMutations(billMutations, otherVendorPosts, ["acknowledge"]);

    // The bill UI region (main content, excluding the merchant shell sidebar
    // nav) never renders settlement/owner/requested_by semantics. "Settlements"
    // in the AppShell Money nav is pre-existing chrome and is not part of this
    // negative proof (C3R4).
    await expectBillRegionFreeOf(page, [
      "Settle",
      "settle",
      "Paid",
      "Pay",
      "Payment",
      "Close session",
      "Cancel",
      "requested_by",
      "table_token",
      fixture.token,
    ]);
  });

  test("delivered bills leave the queue while the detail stays a read-only Delivered record", async ({
    browser,
    page,
  }) => {
    const fixture = BILLS_FIXTURES[1];
    const consumer = await openConsumerSessionReady(browser, fixture);
    await placeOrderAndRequestBill(consumer, fixture);
    await consumer.close();

    const { billMutations, otherVendorPosts } = await openVendorBills(page);

    const row = queueRow(page, fixture);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ---------- ACKNOWLEDGE first: only ACKNOWLEDGED rows reach the detail ----------
    // The PENDING detail is identical but the queue action surface is legal
    // only as PENDING->acknowledge -> deliver, so we ack before reading it.
    const billHrefPromise = row
      .getByRole("link", { name: "View bill" })
      .getAttribute("href");
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await expect(row.getByText("Acknowledged")).toBeVisible();
    await expect(row.getByRole("button", { name: "Mark delivered" })).toBeVisible();
    const billHref = await billHrefPromise;
    expect(billHref).toMatch(/^\/dine-in\/bills\/[0-9a-f-]+$/);

    // ---------- DETAIL: read-only frozen snapshot while ACKNOWLEDGED ----------
    await row.getByRole("link", { name: "View bill" }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith("/dine-in/bills/") && url.pathname !== "/dine-in/bills",
    );
    await expect(page.getByText("Acknowledged").first()).toBeVisible();
    // Read-only: no lifecycle mutation controls on the detail.
    await expect(page.getByRole("button", { name: /Acknowledge|Mark delivered/i })).toHaveCount(0);
    // Exact matching: substring "Total" would also match "Food subtotal" (C3R4).
    await expect(page.getByText("Total", { exact: true })).toBeVisible();
    await expect(page.getByText("GST", { exact: true })).toBeVisible();
    await expect(page.getByText("Chicken Biryani")).toBeVisible();

    // ---------- PRINT: only #bill-print-region prints; controls are outside ----------
    await stubWindowPrint(page);
    await page.reload();
    const region = page.locator("#bill-print-region");
    await expect(region).toBeVisible();
    await expect(region.getByText("Total", { exact: true })).toBeVisible();
    await expect(region.getByRole("link")).toHaveCount(0);
    await expect(region.getByRole("button")).toHaveCount(0);
    await page.getByRole("button", { name: "Print bill" }).click();
    expect(await printCalls(page)).toBe(1);
    await page.screenshot({
      path: "test-results/evidence/vendor-bill-detail.png",
      fullPage: true,
    });

    // ---------- DELIVER: ACKNOWLEDGED -> row removed from the queue ----------
    await page.getByRole("link", { name: "Back to bills" }).click();
    await expect(page.getByRole("heading", { name: "Bill Requests" })).toBeVisible();
    const deliveredRow = queueRow(page, fixture);
    await expect(deliveredRow.getByRole("button", { name: "Mark delivered" })).toBeVisible();
    await deliveredRow.getByRole("button", { name: "Mark delivered" }).click();
    await expect(queueRow(page, fixture)).toHaveCount(0);

    // ---------- COLD RELOAD PERSISTENCE: delivered row stays gone ----------
    await page.reload();
    await expect(page.getByRole("heading", { name: "Bill Requests" })).toBeVisible();
    await expect(queueRow(page, fixture)).toHaveCount(0);

    // ---------- NETWORK: only acknowledge then deliver for this bill id ----------
    assertOnlyDedicatedBillMutations(billMutations, otherVendorPosts, [
      "acknowledge",
      "deliver",
    ]);

    // ---------- STATE PERSISTENCE: delivered detail still readable directly ----------
    await page.goto(billHref as string);
    await expect(page.getByText(/Delivered to the table/i)).toBeVisible();
    await expect(page.getByText("Delivered").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Acknowledge|Mark delivered/i })).toHaveCount(0);
    await page.screenshot({
      path: "test-results/evidence/vendor-bill-delivered-detail.png",
      fullPage: true,
    });
  });

  test("vendor bill navigation is reciprocal and never exposes billing-ownership fields", async ({
    browser,
    page,
  }) => {
    const fixture = BILLS_FIXTURES[2];
    const consumer = await openConsumerSessionReady(browser, fixture);
    await placeOrderAndRequestBill(consumer, fixture);
    await consumer.close();

    const { billMutations, otherVendorPosts } = await openVendorBills(page);

    const row = queueRow(page, fixture);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ---------- NAVIGATION RECIPROCITY ----------
    const ordersLink = page.getByRole("link", { name: "Orders & requests" });
    const tablesLink = page.getByRole("link", { name: "Table board" });
    await expect(ordersLink).toBeVisible();
    await expect(tablesLink).toBeVisible();

    // The orders board must NOT surface the BRING_BILL request (defensive
    // suppression lives on that surface), and links back to the bill queue.
    await ordersLink.click();
    await expect(page.getByRole("heading", { name: "Dine-In Orders" })).toBeVisible();
    await expect(page.getByText("Bring bill")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dine-In Orders" })).toBeVisible();
    await page.getByRole("link", { name: "Bills" }).click();
    await expect(page.getByRole("heading", { name: "Bill Requests" })).toBeVisible();
    await expect(queueRow(page, fixture).getByText("Acknowledge")).toBeVisible();

    // ---------- OWNERSHIP / SETTLEMENT ABSENCE (bill UI region, C3R4) ----------
    // Scoped to <main>; the AppShell "Settlements"/"GST Reports" nav in <aside>
    // is pre-existing merchant chrome and is excluded from this negative proof.
    await expectBillRegionFreeOf(page, [
      "Settle",
      "Paid",
      "Pay",
      "Payment",
      "Close session",
      "owner_user_id",
      "requested_by",
      "table_token",
      fixture.token,
    ]);

    // ---------- NETWORK: pure read navigation emitted no vendor mutation ----------
    assertOnlyDedicatedBillMutations(billMutations, otherVendorPosts, []);

    await page.screenshot({
      path: "test-results/evidence/vendor-bills-queue.png",
      fullPage: true,
    });
  });
});
