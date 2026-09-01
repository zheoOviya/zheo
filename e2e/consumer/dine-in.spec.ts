import { test, expect, type Page, type Request } from "@playwright/test";
import { uniquePhone } from "../helpers/constants";
import {
  DINE_IN_FIXTURE_RESTAURANT_ID,
  DINE_IN_FIXTURE_RESTAURANT_NAME,
  DINE_IN_FIXTURE_TABLE_ID,
  DINE_IN_FIXTURE_TABLE_LABEL,
  DINE_IN_FIXTURE_TABLE_TOKEN,
} from "./dine-in-fixture.constants";

// ============================================
// UI8-B1 — Dine-In Browser Track A (QR entry -> authenticated session open ->
// token-free SESSION_READY handoff).
// UI8-B2 — Dine-In Browser Track B (View Menu -> menu skeleton -> loaded menu).
// UI8-B5.1 — Dine-In Browser Track E-1 (open "Need something?" service panel ->
// exactly the seven allowed actions -> NO service-request network call).
//
// Each track deliberately stops at its own boundary: Track A performs no menu
// catalog assertions; Track B performs no Add, no order, no service request, no
// bill.
// All five browser evidence classes are captured for Track A:
//   1. Interaction proof      — explicit Continue clicks, login, View Menu
//   2. Network emission proof — resolve GET (200, no auth), POST /sessions
//                               (200, authenticated, body key == table_token)
//   3. DOM mutation proof     — resolving->resolved and resolved->SESSION_READY
//   4. Visual snapshot        — track-a1-resolved.png / track-a2-session-ready.png
//   5. State persistence      — SPA context survives to /dine-in/menu (token-free)
//
// Sanitization: the opaque table token is never printed in output or screenshots;
// the Authorization header value and raw session ids are never logged. Request
// paths are logged without query strings.
//
// RUN MODEL — FRESH STACK PER CHECKPOINT: the deterministic fixture enforces a
// single live session per table (openSession rejects a second, different-owner
// open on the same table with "already in use"), and process restart is the
// ONLY sanctioned reset (no HTTP reset surface). Therefore Track A and Track B
// each consume the table session for their run and MUST be verified on a fresh
// stack, e.g.:
//   npx playwright test e2e/consumer/dine-in.spec.ts --project=consumer --grep "QR entry"
//   npx playwright test e2e/consumer/dine-in.spec.ts --project=consumer --grep "skeleton -> loaded"
// ============================================

const ENTRY = `/dine-in?table=${DINE_IN_FIXTURE_TABLE_TOKEN}`;

test.use({ viewport: { width: 375, height: 667 } });

interface ResolveCall {
  auth: boolean;
  status: number;
}
interface SessionPost {
  auth: boolean;
  status: number;
}
interface MenuReq {
  auth: boolean;
  status: number;
}
interface MenuResp {
  count: number;
  names: string[];
  prices: number[];
}
interface OrderReq {
  auth: boolean;
  status: number;
}
interface OrderReqBodyShape {
  topKeys: string[];
  itemKeys: string[];
  quantities: number[];
  itemCount: number;
  raw: Record<string, unknown>;
}
interface OrderResp {
  status: string;
  total: number;
}
interface ServiceReq {
  auth: boolean;
  status: number;
}
interface ServiceReqBodyShape {
  topKeys: string[];
  requestType: string | null;
  raw: Record<string, unknown>;
}
interface ServiceResp {
  status: string | null;
}
interface BillReq {
  auth: boolean;
  status: number;
}
interface BillResp {
  sessionStatus: string | null;
  foodSubtotal: number | null;
  gstFood: number | null;
  packagingFee: number | null;
  gstPackaging: number | null;
  totalAmount: number | null;
}

test.describe("Dine-In Track A (UI8-B1)", () => {
  let resolveCalls: ResolveCall[] = [];
  let sessionPosts: SessionPost[] = [];
  let sessionReqBodyKeys: string[][] = [];
  let sessionResp: Array<{ status: string; restaurantMatches: boolean; tableMatches: boolean }> = [];
  let orderCalls: string[] = [];
  let menuCalls: string[] = [];
  let serviceCalls: string[] = [];
  let billCalls: string[] = [];
  let menuRequests: MenuReq[] = [];
  let menuResp: MenuResp[] = [];
  let cartCalls: string[] = [];
  let apiCalls: string[] = [];
  let orderRequests: OrderReq[] = [];
  let orderReqBodies: OrderReqBodyShape[] = [];
  let orderResp: OrderResp[] = [];
  let serviceRequests: ServiceReq[] = [];
  let serviceReqBodies: ServiceReqBodyShape[] = [];
  let serviceResp: ServiceResp[] = [];
  let serviceRequestApiCalls: string[] = [];
  let billRequests: BillReq[] = [];
  let billReqBodyKeys: string[][] = [];
  let billResp: BillResp[] = [];

  test.beforeEach(async ({ page }) => {
    resolveCalls = [];
    sessionPosts = [];
    sessionReqBodyKeys = [];
    sessionResp = [];
    orderCalls = [];
    menuCalls = [];
    serviceCalls = [];
    billCalls = [];
    menuRequests = [];
    menuResp = [];
    cartCalls = [];
    apiCalls = [];
    orderRequests = [];
    orderReqBodies = [];
    orderResp = [];
    serviceRequests = [];
    serviceReqBodies = [];
    serviceResp = [];
    serviceRequestApiCalls = [];
    billRequests = [];
    billReqBodyKeys = [];
    billResp = [];
    const resolveByReq = new Map<Request, ResolveCall>();
    const sessionByReq = new Map<Request, SessionPost>();
    const menuReqByReq = new Map<Request, MenuReq>();
    const orderReqByReq = new Map<Request, OrderReq>();
    const serviceReqByReq = new Map<Request, ServiceReq>();
    const billReqByReq = new Map<Request, BillReq>();

    // First-run OnboardingGate bypass (same as the existing consumer helper).
    await page.addInitScript(() => {
      localStorage.setItem("snakzap_onboarded", "1");
    });

    // Deterministic loading-state observation: delay the real response only.
    // No data fabrication — route.continue() returns the genuine payload.
    await page.route("**/api/v1/dine-in/tables/resolve", async (route) => {
      await new Promise((r) => setTimeout(r, 250));
      await route.continue();
    });
    await page.route("**/api/v1/dine-in/sessions", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 250));
      }
      await route.continue();
    });

    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path === "/api/v1/dine-in/tables/resolve") {
        const entry: ResolveCall = { auth: !!req.headers()["authorization"], status: 0 };
        resolveByReq.set(req, entry);
        resolveCalls.push(entry);
      } else if (path === "/api/v1/dine-in/sessions" && req.method() === "POST") {
        const entry: SessionPost = { auth: !!req.headers()["authorization"], status: 0 };
        sessionByReq.set(req, entry);
        sessionPosts.push(entry);
        try {
          sessionReqBodyKeys.push(Object.keys(req.postDataJSON() ?? {}));
        } catch {
          sessionReqBodyKeys.push([]);
        }
      } else if (path === "/api/v1/dine-in/orders") {
        orderCalls.push(req.method());
        if (req.method() === "POST") {
          const entry: OrderReq = { auth: !!req.headers()["authorization"], status: 0 };
          orderReqByReq.set(req, entry);
          orderRequests.push(entry);
          try {
            const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
            const items = Array.isArray(body.items)
              ? (body.items as Array<Record<string, unknown>>)
              : [];
            orderReqBodies.push({
              topKeys: Object.keys(body),
              itemKeys: items[0] ? Object.keys(items[0]) : [],
              quantities: items.map((i) => (i as { quantity: number }).quantity),
              itemCount: items.length,
              raw: body,
            });
          } catch {
            orderReqBodies.push({
              topKeys: [],
              itemKeys: [],
              quantities: [],
              itemCount: 0,
              raw: {},
            });
          }
        }
      } else if (/^\/api\/v1\/restaurants\/[^/]+\/menu$/.test(path)) {
        menuCalls.push(req.method());
        const entry: MenuReq = { auth: !!req.headers()["authorization"], status: 0 };
        menuReqByReq.set(req, entry);
        menuRequests.push(entry);
      } else if (path === "/api/v1/dine-in/service-requests") {
        serviceCalls.push(req.method());
        if (req.method() === "POST") {
          const entry: ServiceReq = { auth: !!req.headers()["authorization"], status: 0 };
          serviceReqByReq.set(req, entry);
          serviceRequests.push(entry);
          try {
            const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
            serviceReqBodies.push({
              topKeys: Object.keys(body),
              requestType: typeof body.request_type === "string" ? body.request_type : null,
              raw: body,
            });
          } catch {
            serviceReqBodies.push({ topKeys: [], requestType: null, raw: {} });
          }
        }
      } else if (/^\/api\/v1\/dine-in\/sessions\/[^/]+\/bill$/.test(path)) {
        billCalls.push(req.method());
        if (req.method() === "POST") {
          const entry: BillReq = { auth: !!req.headers()["authorization"], status: 0 };
          billReqByReq.set(req, entry);
          billRequests.push(entry);
          try {
            billReqBodyKeys.push(Object.keys(req.postDataJSON() ?? {}));
          } catch {
            billReqBodyKeys.push([]);
          }
        }
      }
      // Every API request on the page is recorded for the Track C zero-mutation
      // negative proof. Pickup-cart persistence is captured separately.
      if (path.startsWith("/api/v1/dine-in/service-requests")) {
        serviceRequestApiCalls.push(`${req.method()} ${path}`);
      }
      if (path.startsWith("/api/")) {
        apiCalls.push(`${req.method()} ${path}`);
        if (path === "/api/v1/cart" || path.startsWith("/api/v1/cart/")) {
          cartCalls.push(req.method());
        }
      }
    });

    page.on("response", (res) => {
      const path = new URL(res.url()).pathname;
      if (path === "/api/v1/dine-in/tables/resolve") {
        const entry = resolveByReq.get(res.request());
        if (entry) entry.status = res.status();
      } else if (path === "/api/v1/dine-in/sessions" && res.request().method() === "POST") {
        const entry = sessionByReq.get(res.request());
        if (entry) entry.status = res.status();
        void res
          .json()
          .then((j) => {
            const s = j?.data?.session;
            if (s) {
              sessionResp.push({
                status: s.status,
                restaurantMatches: s.restaurant_id === DINE_IN_FIXTURE_RESTAURANT_ID,
                tableMatches: s.table_id === DINE_IN_FIXTURE_TABLE_ID,
              });
            }
          })
          .catch(() => undefined);
      } else if (/^\/api\/v1\/restaurants\/[^/]+\/menu$/.test(path)) {
        const entry = menuReqByReq.get(res.request());
        if (entry) entry.status = res.status();
        void res
          .json()
          .then((j) => {
            const items = j?.data;
            if (Array.isArray(items)) {
              menuResp.push({
                count: items.length,
                names: items.map((i: { name: string }) => i.name),
                prices: items.map((i: { price: number }) => i.price),
              });
            }
          })
          .catch(() => undefined);
      } else if (path === "/api/v1/dine-in/orders" && res.request().method() === "POST") {
        const entry = orderReqByReq.get(res.request());
        if (entry) entry.status = res.status();
        void res
          .json()
          .then((j) => {
            const o = j?.data?.order;
            if (o) {
              orderResp.push({ status: o.status, total: o.total_amount });
            }
          })
          .catch(() => undefined);
      } else if (path === "/api/v1/dine-in/service-requests" && res.request().method() === "POST") {
        const entry = serviceReqByReq.get(res.request());
        if (entry) entry.status = res.status();
        void res
          .json()
          .then((j) => {
            const r = j?.data?.request;
            if (r) serviceResp.push({ status: r.status });
          })
          .catch(() => undefined);
      } else if (
        /^\/api\/v1\/dine-in\/sessions\/[^/]+\/bill$/.test(path) &&
        res.request().method() === "POST"
      ) {
        const entry = billReqByReq.get(res.request());
        if (entry) entry.status = res.status();
        void res
          .json()
          .then((j) => {
            const d = j?.data;
            const s = d?.session;
            const b = d?.bill;
            if (s && b) {
              billResp.push({
                sessionStatus: s.status,
                foodSubtotal: b.food_subtotal,
                gstFood: b.gst_food,
                packagingFee: b.packaging_fee,
                gstPackaging: b.gst_packaging,
                totalAmount: b.total_amount,
              });
            }
          })
          .catch(() => undefined);
      }
    });
  });

  async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  async function assertBottomActionInViewport(page: Page, label: RegExp): Promise<void> {
    const box = await page.getByRole("button", { name: label }).boundingBox();
    const vh = await page.evaluate(() => window.innerHeight);
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh);
  }

  // Shared Track-A entry prerequisite: QR entry -> public resolve -> explicit
  // authenticated session open -> SESSION_READY. Reused verbatim by Track B.
  async function openSessionReady(page: Page): Promise<void> {
    await page.goto(ENTRY);
    await expect(page.getByText("Checking your table...")).toBeVisible();
    await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^Continue/ }).click();
    await page.waitForURL(/\/login/);

    const phone = uniquePhone();
    await page.locator("#phone-input").fill(phone);
    await page.getByRole("button", { name: "Send OTP" }).click();
    const verify = page.getByRole("button", { name: "Verify & Sign In" });
    await expect(verify).toBeEnabled({ timeout: 15_000 });
    await verify.click();

    await page.waitForURL((url) => url.pathname === "/dine-in" && url.searchParams.has("table"));
    await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /^Continue/ }).click();
    await expect(page.getByText("Opening session...")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Session ready")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("View Menu")).toBeVisible();
  }

  test("Track A: QR entry -> resolve -> authenticated session open -> token-free handoff", async ({
    page,
  }) => {
    // ---------- INTERACTION + NETWORK: QR entry, no auth yet ----------
    await page.goto(ENTRY);

    // ---------- DOM MUTATION: resolving -> resolved ----------
    await expect(page.getByText("Checking your table...")).toBeVisible();
    await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Checking your table...")).not.toBeVisible();

    // ---------- RESOLVED DOM ----------
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
    await expect(page.getByText("Ready to order")).toBeVisible();

    // Token never rendered. NOTE: document.body.textContent also includes the
    // Next.js dev-mode RSC flight payload (a <script> carrying the token prop),
    // so the user-visibility guarantee is asserted on rendered text (innerText)
    // — scripts produce no rendered text.
    const bodyResolved = await page.evaluate(() => document.body.innerText);
    expect(bodyResolved).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

    // ---------- NETWORK: resolve GET 200, public (no Authorization) ----------
    await expect.poll(() => resolveCalls.length).toBe(1);
    expect(resolveCalls[0].status).toBe(200);
    expect(resolveCalls[0].auth).toBe(false);

    // No session mutation before an explicit action.
    expect(sessionPosts.length).toBe(0);

    // ---------- NARROW MOBILE SANITY (375px) ----------
    await assertNoHorizontalOverflow(page);

    // ---------- VISUAL 1: resolved QR entry ----------
    await page.screenshot({
      path: "test-results/evidence/track-a1-resolved.png",
      fullPage: true,
    });

    // ---------- INTERACTION: explicit Continue -> auth gate -> login ----------
    const continueBtn = page.getByRole("button", { name: /^Continue/ });
    await expect(continueBtn).toBeEnabled();
    await assertBottomActionInViewport(page, /^Continue/);
    await continueBtn.click();
    await page.waitForURL(/\/login/);

    // Existing dev OTP flow (unique phone per run).
    const phone = uniquePhone();
    await page.locator("#phone-input").fill(phone);
    await page.getByRole("button", { name: "Send OTP" }).click();
    const verify = page.getByRole("button", { name: "Verify & Sign In" });
    await expect(verify).toBeEnabled({ timeout: 15_000 });
    await verify.click();

    // Return to the original Dine-In entry, token preserved in URL.
    await page.waitForURL((url) => url.pathname === "/dine-in" && url.searchParams.has("table"));

    // Resolve fires again post-login and remains public (no auth header).
    await expect(page.getByText("Ready to order")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => resolveCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of resolveCalls) {
      expect(c.auth).toBe(false);
      if (c.status > 0) expect(c.status).toBe(200);
    }

    // SESSION_READY is NOT present before the explicit open mutation.
    await expect(page.getByText("Session ready")).not.toBeVisible();

    // ---------- INTERACTION: explicit Continue -> opening -> SESSION_READY ----------
    await page.getByRole("button", { name: /^Continue/ }).click();
    await expect(page.getByText("Opening session...")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Session ready")).toBeVisible({ timeout: 15_000 });

    // ---------- NETWORK: exactly one authenticated POST /sessions, 200 ----------
    await expect.poll(() => sessionPosts.length).toBe(1);
    expect(sessionPosts[0].auth).toBe(true);
    expect(sessionPosts[0].status).toBe(200);

    // Request body carries exactly table_token — no restaurant/table/pricing keys.
    expect(sessionReqBodyKeys[0]).toEqual(["table_token"]);

    // Response session status OPEN/ACTIVE and matches the fixture restaurant/table.
    await expect.poll(() => sessionResp.length).toBe(1);
    expect(["OPEN", "ACTIVE"]).toContain(sessionResp[0].status);
    expect(sessionResp[0].restaurantMatches).toBe(true);
    expect(sessionResp[0].tableMatches).toBe(true);

    // ---------- DOM MUTATION: SESSION_READY state ----------
    await expect(page.getByText("View Menu")).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();

    // Token still absent from rendered text.
    const bodyReady = await page.evaluate(() => document.body.innerText);
    expect(bodyReady).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

    // No menu/order network before the View Menu handoff (Track B not started).
    expect(menuCalls.length).toBe(0);
    expect(orderCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);

    // ---------- NARROW MOBILE SANITY (375px) ----------
    await assertNoHorizontalOverflow(page);

    // ---------- VISUAL 2: SESSION_READY ----------
    await page.screenshot({
      path: "test-results/evidence/track-a2-session-ready.png",
      fullPage: true,
    });

    // ---------- STATE PERSISTENCE: token-free handoff to /dine-in/menu ----------
    // Intercept the menu catalog fetch so Track B is NOT executed: the
    // request fires on route mount but is aborted before any menu rendering.
    await page.route("**/api/v1/restaurants/*/menu", (route) => route.abort());
    await page.getByRole("button", { name: /View Menu/ }).click();
    await page.waitForURL((url) => url.pathname === "/dine-in/menu");

    // Target URL is token-free (no query string at all).
    const menuUrl = new URL(page.url());
    expect(menuUrl.pathname).toBe("/dine-in/menu");
    expect(menuUrl.search).toBe("");

    // The menu shell reads NO searchParams — rendering trusted display data
    // here proves the SPA context store survived the navigation.
    await expect(page.getByText("Dine-In Menu")).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();

    // Token never rendered on the handoff shell either.
    const bodyMenu = await page.evaluate(() => document.body.innerText);
    expect(bodyMenu).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

    // Menu fetch was attempted exactly once on mount and aborted (Track B
    // remains unexecuted). No order/service/bill calls anywhere.
    await expect.poll(() => menuCalls.length).toBe(1);
    expect(orderCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);

    await page.screenshot({
      path: "test-results/evidence/track-a3-menu-handoff.png",
      fullPage: true,
    });

    // ---------- SANITIZED EVIDENCE SUMMARY (no token, no Authorization, no ids) ----------
    console.log(
      "EVIDENCE resolve calls (status, sentAuthorization):",
      JSON.stringify(resolveCalls.map((c) => [c.status, c.auth])),
    );
    console.log(
      "EVIDENCE session posts (status, sentAuthorization):",
      JSON.stringify(sessionPosts.map((c) => [c.status, c.auth])),
    );
    console.log(
      "EVIDENCE session request body keys:",
      JSON.stringify(sessionReqBodyKeys),
    );
    console.log(
      "EVIDENCE session response (status, restaurantMatchesFixture, tableMatchesFixture):",
      JSON.stringify(sessionResp),
    );
    console.log("EVIDENCE menu/order/service/bill calls (count):", menuCalls.length, orderCalls.length, serviceCalls.length, billCalls.length);
  });

  test("Track B: View Menu -> skeleton -> loaded menu (UI8-B2)", async ({ page }) => {
    // ---------- PREREQUISITE: accepted Track-A entry to SESSION_READY ----------
    await openSessionReady(page);

    // No catalog request yet — Track B interaction not started.
    expect(menuCalls.length).toBe(0);

    // Deterministic loading-state observation: delay the REAL menu response only
    // (route.continue() returns the genuine fixture catalog — no mock contents).
    await page.route("**/api/v1/restaurants/*/menu", async (route) => {
      await new Promise((r) => setTimeout(r, 900));
      await route.continue();
    });

    // ---------- INTERACTION PROOF: explicit View Menu click ----------
    await page.getByRole("button", { name: /View Menu/ }).click();
    await page.waitForURL((url) => url.pathname === "/dine-in/menu");
    const b2Url = new URL(page.url());
    expect(b2Url.pathname).toBe("/dine-in/menu");
    expect(b2Url.search).toBe("");

    // ---------- NETWORK: restaurant-scoped catalog GET emitted ----------
    await expect.poll(() => menuRequests.length).toBe(1);

    // ---------- DOM MUTATION (LOADING): skeletons, header, no blank content ----------
    await expect(page.locator(".animate-skeleton-teal")).toHaveCount(20);
    await expect(page.getByText("Dine-In Menu")).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
    await expect(page.getByText("Chicken Biryani")).not.toBeVisible();
    await assertNoHorizontalOverflow(page);

    // ---------- VISUAL SNAPSHOT B1: menu-loading skeleton state ----------
    await page.screenshot({
      path: "test-results/evidence/track-b1-menu-loading.png",
      fullPage: true,
    });

    // ---------- DOM MUTATION (LOADED): skeleton -> truthful food cards ----------
    await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Veg Biryani")).toBeVisible();
    await expect(page.locator(".animate-skeleton-teal")).toHaveCount(0);

    // ---------- NETWORK: GET 200, public, exact fixture contents ----------
    await expect.poll(() => menuResp.length).toBe(1);
    expect(menuRequests[0].status).toBe(200);
    expect(menuRequests[0].auth).toBe(false);
    expect(menuResp[0].count).toBe(2);
    expect(menuResp[0].names).toEqual(expect.arrayContaining(["Chicken Biryani", "Veg Biryani"]));
    expect(menuResp[0].prices).toEqual(expect.arrayContaining([220, 180]));

    // ---------- LOADED MENU DOM: context + items + prices + Add (untouched) ----------
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
    await expect(page.getByText("₹220.00")).toBeVisible();
    await expect(page.getByText("₹180.00")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Chicken Biryani" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Veg Biryani" })).toBeVisible();

    // Add controls are visible but NOT interacted with: no selection -> no
    // Place-order CTA, no order mutation.
    await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);

    // ---------- NO FABRICATION: only the 2 truthful item cards ----------
    expect(await page.locator("div.surface-card").count()).toBe(2);
    await expect(page.getByText("Customize")).toHaveCount(0);
    await expect(page.getByText(/Bestseller|Best Seller|Popular|Trending/i)).toHaveCount(0);
    await expect(page.getByText("Categories")).toHaveCount(0);

    // ---------- I1 APPETITE VISUAL: null image_url -> fallback proof ----------
    // Fixture items carry image_url null, so the truthful path is the BrandImage
    // fallback. Assert: stable 80x80 image box, placeholder svg rendered, NO
    // <img> element (a broken-image icon can only arise from a failed <img>),
    // card stays aligned with no horizontal overflow. object-cover proof is
    // N/A for this fixture (no real image URL) and is asserted as such.
    for (const name of ["Chicken Biryani", "Veg Biryani"]) {
      const card = page.locator("div.surface-card").filter({ hasText: name });
      const imgBox = card.locator("[class*='h-20 w-20']");
      await expect(imgBox).toBeVisible();
      const box = await imgBox.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.width)).toBe(80);
      expect(Math.round(box!.height)).toBe(80);
      expect(box!.width / box!.height).toBeCloseTo(1, 1);
      await expect(imgBox.locator("svg")).toBeVisible();
      expect(await imgBox.locator("img").count()).toBe(0);
      const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }

    // ---------- STATE PERSISTENCE PROOF: context survived SPA navigation ----------
    expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
    const bodyB2 = await page.evaluate(() => document.body.innerText);
    expect(bodyB2).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();

    // ---------- VISUAL SNAPSHOT B2: loaded menu state ----------
    await page.screenshot({
      path: "test-results/evidence/track-b2-menu-loaded.png",
      fullPage: true,
    });

    // ---------- TRACK SCOPE: exactly one menu GET; no order/service/bill ----------
    expect(menuRequests.length).toBe(1);
    expect(orderCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);

    // ---------- SANITIZED EVIDENCE SUMMARY ----------
    console.log(
      "EVIDENCE B menu GET (status, sentAuthorization):",
      JSON.stringify(menuRequests.map((m) => [m.status, m.auth])),
    );
    console.log(
      "EVIDENCE B menu response (count, names, prices):",
      JSON.stringify(menuResp.map((r) => ({ count: r.count, names: r.names, prices: r.prices }))),
    );
    console.log(
      "EVIDENCE B order/service/bill calls (count):",
      orderCalls.length,
      serviceCalls.length,
      billCalls.length,
    );
  });

  test("Track C: Add -> quantity stepper -> local session-scoped selection (UI8-B3)", async ({
    page,
  }) => {
    // ---------- PREREQUISITE: accepted Track A+B setup -> real loaded menu ----------
    await openSessionReady(page);
    await page.getByRole("button", { name: /View Menu/ }).click();
    await page.waitForURL((url) => url.pathname === "/dine-in/menu");
    await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Veg Biryani")).toBeVisible();
    expect(new URL(page.url()).search).toBe("");

    // Sanitized total formatter mirroring the app's formatINR (en-IN currency).
    const fmtINR = (n: number) =>
      new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);

    // Baseline: exactly one catalog GET (Track B setup); the ONLY session POST
    // is the Track-A open. Every later API request would be a mutation.
    expect(menuRequests.length).toBe(1);
    expect(sessionPosts.length).toBe(1);
    expect(orderCalls.length).toBe(0);
    expect(cartCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);
    const apiCallCountBaseline = apiCalls.length;

    const chickenAdd = page.getByRole("button", { name: "Add Chicken Biryani" });
    const chickenQty = page.getByLabel("Chicken Biryani quantity");
    const chickenInc = page.getByRole("button", { name: "Increase Chicken Biryani" });
    const chickenDec = page.getByRole("button", { name: "Decrease Chicken Biryani" });

    // ---------- INTERACTION A: first Add -> qty 1 (instant, client-memory) ----------
    await expect(chickenAdd).toBeVisible();
    await expect(chickenQty).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
    await chickenAdd.click();
    await expect(chickenQty).toHaveText("1");
    await expect(chickenAdd).toHaveCount(0);
    await expect(chickenDec).toBeVisible();
    await expect(chickenInc).toBeVisible();
    await expect(page.getByText("1 item selected")).toBeVisible();
    await expect(page.getByText(`Estimated total: ${fmtINR(220)}`)).toBeVisible();

    // ---------- VISUAL C1: stepper qty 1 ----------
    await page.screenshot({
      path: "test-results/evidence/track-c1-stepper-qty1.png",
      fullPage: true,
    });

    // ---------- INTERACTION B: + -> qty 2 (display-price total) ----------
    await chickenInc.click();
    await expect(chickenQty).toHaveText("2");
    await expect(page.getByText("2 items selected")).toBeVisible();
    await expect(page.getByText(`Estimated total: ${fmtINR(440)}`)).toBeVisible();

    // ---------- INTERACTION C: - -> qty 1 ----------
    await chickenDec.click();
    await expect(chickenQty).toHaveText("1");
    await expect(page.getByText(`Estimated total: ${fmtINR(220)}`)).toBeVisible();

    // ---------- INTERACTION D: - again -> removal, Add returns ----------
    await chickenDec.click();
    await expect(chickenQty).toHaveCount(0);
    await expect(chickenAdd).toBeVisible();
    await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
    await expect(page.getByText("1 item selected")).toHaveCount(0);

    // ---------- NETWORK EMISSION PROOF (negative, A-D): ZERO mutation requests ----------
    expect(orderCalls.length).toBe(0);
    expect(cartCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);
    expect(sessionPosts.length).toBe(1);
    expect(apiCalls.length).toBe(apiCallCountBaseline);

    // ---------- PERSISTENCE SETUP: re-add Chicken to qty 2 ----------
    await chickenAdd.click();
    await expect(chickenQty).toHaveText("1");
    await chickenInc.click();
    await expect(chickenQty).toHaveText("2");

    // ---------- STATE PERSISTENCE PROOF: unrelated Veg interaction leaves it intact ----------
    const vegAdd = page.getByRole("button", { name: "Add Veg Biryani" });
    const vegQty = page.getByLabel("Veg Biryani quantity");
    await vegAdd.click();
    await expect(vegQty).toHaveText("1");
    await expect(page.getByText("3 items selected")).toBeVisible();
    await page.getByRole("button", { name: "Decrease Veg Biryani" }).click();
    await expect(vegQty).toHaveCount(0);
    await expect(page.getByText("2 items selected")).toBeVisible();
    await expect(chickenQty).toHaveText("2");
    await expect(page.getByText(`Estimated total: ${fmtINR(440)}`)).toBeVisible();

    // Scroll away and back on the SAME route — qty survives.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(chickenQty).toHaveText("2");

    // Token-free context preserved.
    expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
    expect(new URL(page.url()).search).toBe("");
    const bodyC = await page.evaluate(() => document.body.innerText);
    expect(bodyC).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
    await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
    await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();

    // ---------- VISUAL C2: qty 2 + selected-count + Estimated total ----------
    await page.screenshot({
      path: "test-results/evidence/track-c2-qty2-summary.png",
      fullPage: true,
    });

    // ---------- MAX-50 BOUNDARY (interaction-driven programmatic button clicks) ----------
    // DINE_IN_MAX_QUANTITY === 50. Real DOM clicks on the real Increase button
    // (via evaluate) drive React's handler — no Zustand store mutation.
    const MAX_QTY = 50;
    for (let i = 2; i < MAX_QTY; i++) {
      await chickenInc.evaluate((el) => (el as HTMLButtonElement).click());
    }
    await expect(chickenQty).toHaveText(String(MAX_QTY));
    await expect(chickenInc).toBeDisabled();
    await chickenInc.evaluate((el) => (el as HTMLButtonElement).click());
    await expect(chickenQty).toHaveText(String(MAX_QTY));
    await expect(page.getByText(`Estimated total: ${fmtINR(MAX_QTY * 220)}`)).toBeVisible();

    // ---------- OPTIONAL UI7-B SPACER SANITY (selection exists) ----------
    await expect(page.getByTestId("dine-in-menu-bottom-spacer")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastCardBox = await page.locator("div.surface-card").last().boundingBox();
    const orderBarBox = await page
      .getByRole("button", { name: "Place order" })
      .boundingBox();
    expect(lastCardBox).not.toBeNull();
    expect(orderBarBox).not.toBeNull();
    expect(lastCardBox!.y + lastCardBox!.height).toBeLessThanOrEqual(orderBarBox!.y + 4);

    // ---------- ORDER-MUTATION BOUNDARY: CTA visible but NOT clicked ----------
    await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
    expect(orderCalls.length).toBe(0);
    await expect(page.getByText("Order placed")).toHaveCount(0);

    // ---------- NETWORK EMISSION PROOF (entire interaction phase): zero mutations ----------
    expect(menuRequests.length).toBe(1);
    expect(cartCalls.length).toBe(0);
    expect(serviceCalls.length).toBe(0);
    expect(billCalls.length).toBe(0);
    expect(sessionPosts.length).toBe(1);
    expect(apiCalls.length).toBe(apiCallCountBaseline);

    // ---------- SANITIZED EVIDENCE SUMMARY ----------
    console.log(
      "EVIDENCE C mutation POSTs (orders, pickup-cart, service, bill, sessions):",
      orderCalls.length,
      cartCalls.length,
      serviceCalls.length,
      billCalls.length,
      sessionPosts.length,
    );
    console.log(
      "EVIDENCE C api request delta during interactions:",
      apiCalls.length - apiCallCountBaseline,
    );
    console.log("EVIDENCE C final chicken qty at max-50 boundary:", MAX_QTY);
  });

  // Track D runs on a taller mobile viewport (375 wide, iPhone-class height):
  // the authoritative success banner lives in the fixed bottom bar, and on the
  // short 667px viewport the whole 2-item menu fits without scroll room, so the
  // lower cards sit permanently behind the taller bar. 375x844 leaves the cards
  // clear of the bar so every interaction remains a real, actionability-checked
  // click (no force clicks).
  test.describe("Track D (UI8-B4)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

      test("Track D: Place order -> submitting -> authoritative success -> selection cleared", async ({
        page,
      }) => {
      // ---------- PREREQUISITE: accepted A/B/C setup -> real loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
  
      // Deterministic selection: Chicken Biryani qty 2.
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveText("1");
      await page.getByRole("button", { name: "Increase Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveText("2");
  
      const fmtINR = (n: number) =>
        new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(n);
  
      const placeOrderBtn = page.getByRole("button", { name: "Place order" });
  
      // ---------- PRE-SUBMIT STATE ----------
      await expect(page.getByText("2 items selected")).toBeVisible();
      await expect(page.getByText(`Estimated total: ${fmtINR(440)}`)).toBeVisible();
      await expect(placeOrderBtn).toBeVisible();
      expect(orderCalls.length).toBe(0);
      await expect(page.getByText("Order placed")).toHaveCount(0);
  
      // ---------- VISUAL D1: selected menu before submit ----------
      await page.screenshot({
        path: "test-results/evidence/track-d1-preselect.png",
        fullPage: true,
      });
  
      // Delay the REAL order response so the submitting state is observable.
      // No content mocking — route.continue() returns the genuine response.
      await page.route("**/api/v1/dine-in/orders", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await route.continue();
      });
  
      // ---------- INTERACTION + DUPLICATE-SUBMISSION PROOF ----------
      // Two synchronous real DOM clicks on the real CTA. The submittingRef guard
      // (set before the first await) makes the second click a no-op, so exactly
      // ONE order POST must be emitted — deterministic, interaction-driven.
      await placeOrderBtn.evaluate((el) => {
        (el as HTMLButtonElement).click();
        (el as HTMLButtonElement).click();
      });
  
      // ---------- DOM MUTATION: submitting ----------
      await expect(page.getByText("Placing order...")).toBeVisible({ timeout: 5_000 });
      await expect.poll(() => orderCalls.length).toBe(1);
  
      // ---------- VISUAL D2: submitting state ----------
      await page.screenshot({
        path: "test-results/evidence/track-d2-submitting.png",
        fullPage: true,
      });
  
      // ---------- AUTHORITATIVE SUCCESS ----------
      await expect(page.getByText("Order placed")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Status: Placed")).toBeVisible();
      // Server-returned authoritative total (food 440 + 5% GST 22 = 462) — NOT the
      // client display ₹440.00. The difference proves the pricing-authority boundary.
      await expect(page.getByText(`Order total: ${fmtINR(462)}`)).toBeVisible();
  
      // ---------- NETWORK EMISSION + AUTH + PAYLOAD BOUNDARY ----------
      await expect.poll(() => orderRequests.length).toBe(1);
      expect(orderRequests[0].auth).toBe(true);
      expect(orderRequests[0].status).toBe(201);
      const ordBody = orderReqBodies[0];
      expect(ordBody.topKeys).toEqual(["session_id", "items"]);
      expect(ordBody.itemCount).toBe(1);
      expect(ordBody.itemKeys).toEqual(["menu_item_id", "quantity"]);
      expect(ordBody.quantities).toEqual([2]);
      const rawStr = JSON.stringify(ordBody.raw).toLowerCase();
      for (const forbidden of [
        "price",
        "displayprice",
        "total",
        "gst",
        "restaurant_id",
        "table_id",
        "customization",
        DINE_IN_FIXTURE_TABLE_TOKEN.toLowerCase(),
      ]) {
        expect(rawStr).not.toContain(forbidden);
      }
  
      // Authoritative server response facts (no raw ids printed).
      expect(orderResp[0].status).toBe("PLACED");
      expect(orderResp[0].total).toBe(462);
  
      // ---------- SELECTION-CLEAR PROOF (only after success) ----------
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveCount(0);
      await expect(page.getByText("2 items selected")).toHaveCount(0);
      await expect(page.getByText(`Estimated total: ${fmtINR(440)}`)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add Chicken Biryani" })).toBeVisible();
      await expect(placeOrderBtn).toHaveCount(0);
  
      // ---------- SESSION CONTEXT RETENTION ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      const bodyD = await page.evaluate(() => document.body.innerText);
      expect(bodyD).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
  
      // ---------- VISUAL D3: success state, selection cleared ----------
      await page.screenshot({
        path: "test-results/evidence/track-d3-success.png",
        fullPage: true,
      });
  
      // ---------- ADDITIVE ORDERING READINESS: menu not frozen, Add usable ----------
      // The Chicken card sits clear of the fixed bottom bar (the main element
      // vertically centers content, so the LAST card lands behind the bar with
      // no scroll room). Re-adding the first item proves the menu list is not
      // globally frozen after a successful order.
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveText("1");
      await expect(page.getByText("1 item selected")).toBeVisible();
      await page.getByRole("button", { name: "Decrease Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add Chicken Biryani" })).toBeVisible();
      await expect(page.getByText("Order placed")).toBeVisible();
  
      // ---------- STATE PERSISTENCE PROOF: banner + cleared selection survive ----------
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.getByText("Order placed")).toBeVisible();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveCount(0);
      await expect(page.getByLabel("Veg Biryani quantity")).toHaveCount(0);
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
  
      // ---------- TRACK SCOPE BOUNDARY ----------
      expect(sessionPosts.length).toBe(1); // Track-A session open (prerequisite)
      expect(menuRequests.length).toBe(1); // Track-B catalog GET (prerequisite)
      expect(orderCalls.length).toBe(1); // Track-D order POST (exactly one)
      expect(cartCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
  
      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE D order POST (status, sentAuthorization):",
        JSON.stringify(orderRequests.map((o) => [o.status, o.auth])),
      );
      console.log(
        "EVIDENCE D order request shape (topKeys, itemKeys, quantities, itemCount):",
        JSON.stringify(orderReqBodies.map((b) => [b.topKeys, b.itemKeys, b.quantities, b.itemCount])),
      );
      console.log(
        "EVIDENCE D order response (status, authoritative total):",
        JSON.stringify(orderResp.map((o) => [o.status, o.total])),
      );
      console.log(
        "EVIDENCE D mutation POSTs (orders, pickup-cart, service, bill, sessions):",
        orderCalls.length,
        cartCalls.length,
        serviceCalls.length,
        billCalls.length,
        sessionPosts.length,
      );
      });
  });

  // Track E-1 (UI8-B5.1): surface the "Need something?" service panel and prove
  // the allowed-actions boundary with ZERO mutation. Runs on the same taller
  // mobile viewport as Track D so the bottom-sheet dialog is fully reachable
  // with real, actionability-checked clicks.
  test.describe("Track E-1 (UI8-B5.1)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track E-1: 'Need something?' opens panel -> exactly 7 allowed actions, zero mutation", async ({
      page,
    }) => {
      // ---------- PREREQUISITE: accepted A/B/C setup -> real loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Veg Biryani")).toBeVisible();
      expect(new URL(page.url()).search).toBe("");

      // Baseline: prerequisites emitted exactly their sanctioned GET/POSTs.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      // ---------- INTERACTION: explicit real click on the service entry ----------
      const trigger = page.getByRole("button", { name: "Need something?" });
      await expect(trigger).toBeVisible();
      await trigger.click();

      // ---------- DIALOG OPENS ----------
      const dialog = page.getByRole("dialog", { name: "Request something" });
      await expect(dialog).toBeVisible();

      // ---------- ALLOWED ACTIONS: exactly the seven customer-creatable types ----------
      const EXPECTED_ACTIONS = [
        "Water",
        "Extra plate",
        "Cutlery",
        "Tissue",
        "Clean table",
        "Call staff",
        "Other",
      ];
      for (const label of EXPECTED_ACTIONS) {
        await expect(dialog.getByRole("button", { name: label })).toBeVisible();
      }
      // Exactly seven action tiles: only the action buttons expose aria-pressed
      // (the Close and Send request buttons do not).
      expect(await dialog.locator("button[aria-pressed]").count()).toBe(7);
      await expect(dialog.getByRole("button", { name: "Send request" })).toBeVisible();

      // ---------- FORBIDDEN ACTIONS absent ----------
      for (const forbidden of ["Bring bill", "Cancel", "Acknowledge", "Complete"]) {
        await expect(
          dialog.getByRole("button", { name: new RegExp(forbidden, "i") }),
        ).toHaveCount(0);
      }

      // ---------- VISUAL E1: open service panel ----------
      await page.screenshot({
        path: "test-results/evidence/track-e1-panel-open.png",
        fullPage: true,
      });

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      const bodyE1 = await page.evaluate(() => document.body.innerText);
      expect(bodyE1).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- NETWORK BOUNDARY: zero API delta while the panel is open ----------
      expect(apiCalls.length).toBe(apiCallCountBaseline);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE E1 service-request calls (methods):",
        JSON.stringify(serviceCalls),
      );
      console.log(
        "EVIDENCE E1 action tiles (expected 7):",
        await dialog.locator("button[aria-pressed]").count(),
      );
      console.log(
        "EVIDENCE E1 api request delta during panel open:",
        apiCalls.length - apiCallCountBaseline,
      );
    });
  });

  // Track E-2 (UI8-B5.2): select Water -> send -> exactly ONE authenticated
  // POST with body {session_id, request_type: WATER} and a visibly submitting
  // state. Success ("Request sent") / PENDING is deliberately NOT verified
  // here — this part stops at submit-start + network proof.
  test.describe("Track E-2 (UI8-B5.2)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track E-2: Water selected -> exactly one POST {session_id, request_type: WATER}, submitting visible", async ({
      page,
    }) => {
      // ---------- PREREQUISITE: accepted A/B/C setup + E-1 panel surface ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      // Baseline: no mutation before the submit.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);

      // ---------- OPEN PANEL ----------
      await page.getByRole("button", { name: "Need something?" }).click();
      const dialog = page.getByRole("dialog", { name: "Request something" });
      await expect(dialog).toBeVisible();

      const sendBtn = dialog.getByRole("button", { name: "Send request" });
      const water = dialog.getByRole("button", { name: "Water" });
      await expect(sendBtn).toBeDisabled();
      await expect(sendBtn).toHaveAttribute("aria-disabled", "true");

      // ---------- WATER SELECTION ----------
      await water.click();
      await expect(water).toHaveAttribute("aria-pressed", "true");
      await expect(water).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "Cutlery" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      // ---------- SEND ENABLED ----------
      await expect(sendBtn).toBeEnabled();
      await expect(sendBtn).toHaveAttribute("aria-disabled", "false");

      // ---------- VISUAL E2a: Water selected, Send enabled ----------
      await page.screenshot({
        path: "test-results/evidence/track-e2-selected.png",
        fullPage: true,
      });

      // Delay the REAL response so the submitting state is observable. No content
      // mocking — route.continue() returns the genuine response.
      await page.route("**/api/v1/dine-in/service-requests", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await route.continue();
      });

      // ---------- DUPLICATE-SUBMIT PROOF (two synchronous real clicks) ----------
      await sendBtn.evaluate((el) => {
        (el as HTMLButtonElement).click();
        (el as HTMLButtonElement).click();
      });
      await expect.poll(() => serviceCalls.length).toBe(1);

      // ---------- SUBMITTING DOM PROOF ----------
      const sendingBtn = dialog.getByRole("button", { name: "Sending..." });
      await expect(sendingBtn).toBeVisible({ timeout: 5_000 });
      await expect(sendingBtn).toBeDisabled();
      await expect(water).toHaveAttribute("aria-pressed", "true");

      // ---------- VISUAL E2b: submitting state ----------
      await page.screenshot({
        path: "test-results/evidence/track-e2-submitting.png",
        fullPage: true,
      });

      // ---------- NETWORK / PAYLOAD BOUNDARY ----------
      await expect.poll(() => serviceRequests.length).toBe(1);
      expect(serviceRequests[0].auth).toBe(true);
      await expect.poll(() => serviceRequests[0].status).toBe(201);
      const srvBody = serviceReqBodies[0];
      expect(srvBody.topKeys).toEqual(["session_id", "request_type"]);
      expect(srvBody.requestType).toBe("WATER");
      const rawE2 = JSON.stringify(srvBody.raw).toLowerCase();
      for (const forbidden of [
        "note",
        "restaurant_id",
        "table_id",
        "status",
        DINE_IN_FIXTURE_TABLE_TOKEN.toLowerCase(),
      ]) {
        expect(rawE2).not.toContain(forbidden);
      }

      // Exactly ONE service-request POST total (the double-click produced one).
      expect(serviceCalls.filter((m) => m === "POST").length).toBe(1);
      // No other mutation anywhere.
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      const bodyE2 = await page.evaluate(() => document.body.innerText);
      expect(bodyE2).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE E2 service POST (status, sentAuthorization):",
        JSON.stringify(serviceRequests.map((s) => [s.status, s.auth])),
      );
      console.log(
        "EVIDENCE E2 request shape (topKeys, requestType):",
        JSON.stringify(serviceReqBodies.map((b) => [b.topKeys, b.requestType])),
      );
      console.log(
        "EVIDENCE E2 service POST count (expected 1):",
        serviceCalls.filter((m) => m === "POST").length,
      );
      console.log(
        "EVIDENCE E2 mutation POSTs (service, orders, cart, bill, sessions):",
        serviceCalls.filter((m) => m === "POST").length,
        orderCalls.length,
        cartCalls.length,
        billCalls.length,
        sessionPosts.length,
      );
    });
  });

  // Track E-3 (UI8-B5.3): after the real 201 response, the panel must show ONLY
  // "Request sent" + the truthful "Pending" (PENDING is the server-returned
  // status) and must NOT fabricate any lifecycle progress (acknowledged,
  // completed, ETA, queue position, staff identity). No second request, no
  // readback/polling, no ack/complete/cancel. "Send another request" is NOT
  // exercised in this part.
  test.describe("Track E-3 (UI8-B5.3)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track E-3: real 201 -> 'Request sent' + truthful Pending only, no fabricated lifecycle", async ({
      page,
    }) => {
      // ---------- PREREQUISITE: accepted B5.2 flow start ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      // Baseline: no mutation before the submit.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);

      // Delay the REAL 201 response so both submitting and success are observable.
      await page.route("**/api/v1/dine-in/service-requests", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await route.continue();
      });

      // ---------- B5.2 SUBMIT (Water -> send) ----------
      await page.getByRole("button", { name: "Need something?" }).click();
      const dialog = page.getByRole("dialog", { name: "Request something" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Water" }).click();
      await expect(dialog.getByRole("button", { name: "Send request" })).toBeEnabled();
      await dialog.getByRole("button", { name: "Send request" }).click();
      await expect(dialog.getByRole("button", { name: "Sending..." })).toBeVisible();

      // ---------- SUCCESS DOM MUTATION: Sending... -> Request sent ----------
      const statusRegion = dialog.getByRole("status");
      await expect(statusRegion.getByText("Request sent")).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByRole("button", { name: "Sending..." })).toHaveCount(0);

      // ---------- RESPONSE / PENDING PROOF ----------
      // Water label remains identifiable in the success region.
      await expect(statusRegion.getByText("Water")).toBeVisible();
      // The status shown is exactly "Pending" — rendered only for PENDING.
      await expect(statusRegion.getByText("Status: Pending")).toBeVisible();
      // Real response: status === PENDING, HTTP 201.
      await expect.poll(() => serviceResp.length).toBe(1);
      expect(serviceResp[0].status).toBe("PENDING");
      await expect.poll(() => serviceRequests[0].status).toBe(201);

      // ---------- TRUTHFULNESS BOUNDARY ----------
      const dialogText = (await dialog.innerText()).toLowerCase();
      for (const forbidden of ["acknowledged", "completed", "eta", "queue", "queued", "staff"]) {
        expect(dialogText).not.toContain(forbidden);
      }
      // "Send another request" is present but NOT exercised (B5.3 boundary).
      await expect(dialog.getByRole("button", { name: "Send another request" })).toBeVisible();

      // ---------- VISUAL E3: success state ----------
      await page.screenshot({
        path: "test-results/evidence/track-e3-success.png",
        fullPage: true,
      });

      // ---------- NETWORK LIFECYCLE BOUNDARY ----------
      expect(serviceCalls.filter((m) => m === "POST").length).toBe(1);
      expect(serviceRequestApiCalls).toEqual(["POST /api/v1/dine-in/service-requests"]);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      const bodyE3 = await page.evaluate(() => document.body.innerText);
      expect(bodyE3).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE E3 response request status (real):",
        JSON.stringify(serviceResp),
      );
      console.log(
        "EVIDENCE E3 service-request API calls (method path):",
        JSON.stringify(serviceRequestApiCalls),
      );
      console.log(
        "EVIDENCE E3 service POST count (expected 1):",
        serviceCalls.filter((m) => m === "POST").length,
      );
      console.log(
        "EVIDENCE E3 mutation POSTs (service, orders, cart, bill, sessions):",
        serviceCalls.filter((m) => m === "POST").length,
        orderCalls.length,
        cartCalls.length,
        billCalls.length,
        sessionPosts.length,
      );
    });
  });

  // Track F1 (UI8-B6.1): the FIRST tap on "Request bill" must ONLY open the
  // deliberate confirmation dialog — no ordering freeze, no bill mutation,
  // no service request, no payment call before confirmation. The confirm CTA
  // is present but NOT clicked in this part.
  test.describe("Track F1 (UI8-B6.1)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track F1: 'Request bill' opens confirmation only — no freeze, no bill POST", async ({
      page,
    }) => {
      // ---------- PREREQUISITE: accepted A/B/C setup -> real loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Veg Biryani")).toBeVisible();
      expect(new URL(page.url()).search).toBe("");

      // ---------- BILL ENTRY INTERACTION ----------
      // Entry is separate from the service entry ("Need something?").
      const billTrigger = page.getByRole("button", { name: "Request bill" });
      await expect(billTrigger).toBeVisible();
      await expect(page.getByRole("button", { name: "Need something?" })).toBeVisible();
      expect(await billTrigger.count()).toBe(1);

      // Baseline: no mutation of any kind before the first tap.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(billCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      // ---------- FIRST TAP: opens confirmation ONLY ----------
      await billTrigger.click();
      const dialog = page.getByRole("dialog", { name: "Request the bill" });
      await expect(dialog).toBeVisible();

      // ---------- CONFIRMATION COPY ----------
      await expect(
        dialog.getByText("Requesting the bill will stop new orders for this session."),
      ).toBeVisible();

      // ---------- CONFIRM + SECONDARY ACTIONS ----------
      const confirmBtn = dialog.getByRole("button", { name: "Request bill" });
      await expect(confirmBtn).toBeVisible();
      await expect(confirmBtn).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "Keep ordering" })).toBeVisible();

      // ---------- NO ORDERING FREEZE YET ----------
      // The menu is NOT frozen while the confirmation is open: Add is still
      // enabled (we never confirm in this part).
      await expect(page.getByRole("button", { name: "Add Chicken Biryani" })).toBeEnabled();

      // ---------- VISUAL F1: confirmation dialog ----------
      await page.screenshot({
        path: "test-results/evidence/track-f1-confirmation.png",
        fullPage: true,
      });

      // ---------- NETWORK BOUNDARY (before confirmation) ----------
      expect(billCalls.length).toBe(0);
      expect(apiCalls.length).toBe(apiCallCountBaseline);
      expect(serviceCalls.length).toBe(0);
      expect(serviceRequestApiCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- BRING_BILL / PAYMENT BOUNDARY ----------
      const paymentCalls = apiCalls.filter((c) => c.toLowerCase().includes("payment"));
      expect(paymentCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      const bodyF1 = await page.evaluate(() => document.body.innerText);
      expect(bodyF1).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE F1 bill POST calls (expected 0):",
        billCalls.length,
      );
      console.log(
        "EVIDENCE F1 service-request API calls:",
        JSON.stringify(serviceRequestApiCalls),
      );
      console.log(
        "EVIDENCE F1 payment API calls (expected 0):",
        paymentCalls.length,
      );
      console.log(
        "EVIDENCE F1 api request delta during confirmation dialog:",
        apiCalls.length - apiCallCountBaseline,
      );
    });
  });

  // Track F2 (UI8-B6.2): confirm -> exactly ONE concurrent authenticated bill
  // POST with NO client billing body; UI visibly submitting. "Bill requested",
  // bill totals and the ordering freeze are NOT verified here.
  test.describe("Track F2 (UI8-B6.2)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track F2: confirm 'Request bill' -> exactly one body-less authenticated POST, submitting visible", async ({
      page,
    }) => {
      // ---------- PREREQUISITE: accepted A/B/C + Track D order ----------
      // The billing route only accepts an ACTIVE session with billable item
      // snapshots (requestBill: OPEN -> 400 SESSION_NOT_BILLABLE). Placing a
      // Track-D order (Chicken qty2) performs the first-order OPEN -> ACTIVE
      // activation, so the confirm emits a REAL 200 bill POST.
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await page.getByRole("button", { name: "Increase Chicken Biryani" }).click();
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByText("Order placed")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Status: Placed")).toBeVisible();
      expect(orderCalls.length).toBe(1);

      // ---------- ACCEPTED F1 CONFIRMATION DIALOG ----------
      await expect(page.getByRole("button", { name: "Request bill" })).toBeVisible();
      expect(billCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(1); // Track-D prerequisite only
      expect(cartCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      await page.getByRole("button", { name: "Request bill" }).click();
      const dialog = page.getByRole("dialog", { name: "Request the bill" });
      await expect(dialog).toBeVisible();
      const confirmBtn = dialog.getByRole("button", { name: "Request bill" });
      await expect(confirmBtn).toBeEnabled();

      // Delay the REAL bill response so the submitting state is observable.
      await page.route("**/api/v1/dine-in/sessions/*/bill", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 2000));
        }
        await route.continue();
      });

      // ---------- CONFIRM INTERACTION + DUPLICATE-SUBMIT PROOF ----------
      // Two synchronous real DOM clicks: submittingRef (set before the first
      // await) makes the second a no-op -> exactly one concurrent POST.
      await confirmBtn.evaluate((el) => {
        (el as HTMLButtonElement).click();
        (el as HTMLButtonElement).click();
      });
      await expect.poll(() => billCalls.filter((m) => m === "POST").length).toBe(1);

      // ---------- SUBMITTING DOM PROOF ----------
      const requestingBtn = dialog.getByRole("button", { name: "Requesting bill..." });
      await expect(requestingBtn).toBeVisible({ timeout: 5_000 });
      await expect(requestingBtn).toBeDisabled();
      await expect(requestingBtn).toHaveAttribute("aria-disabled", "true");
      await expect(dialog.getByRole("button", { name: "Keep ordering" })).toBeDisabled();

      // ---------- VISUAL F2: submitting state ----------
      await page.screenshot({
        path: "test-results/evidence/track-f2-submitting.png",
        fullPage: true,
      });

      // ---------- MENU READABLE WHILE IN FLIGHT ----------
      await expect(page.getByText("Chicken Biryani").first()).toBeVisible();

      // ---------- BILL NETWORK / BODY / AUTH BOUNDARY ----------
      // Drain the real 200 response so the delayed route completes cleanly
      // (no success/freeze assertions here — B6.3 territory).
      await expect.poll(() => billRequests[0]?.status).toBe(200);
      expect(billCalls.filter((m) => m === "POST").length).toBe(1);
      expect(billRequests[0].auth).toBe(true);
      expect(billRequests[0].status).toBe(200);
      // No client billing fields: the request carries NO body at all.
      expect(billReqBodyKeys[0]).toEqual([]);
      expect(apiCalls.length - apiCallCountBaseline).toBe(1); // the single bill POST

      // ---------- BRING_BILL / PAYMENT BOUNDARY ----------
      expect(serviceCalls.length).toBe(0);
      expect(serviceRequestApiCalls.length).toBe(0);
      const paymentCalls = apiCalls.filter((c) => c.toLowerCase().includes("payment"));
      expect(paymentCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      const bodyF2 = await page.evaluate(() => document.body.innerText);
      expect(bodyF2).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE F2 bill POST (status, sentAuthorization, bodyKeys):",
        JSON.stringify(
          billRequests.map((b, i) => [b.status, b.auth, billReqBodyKeys[i] ?? []]),
        ),
      );
      console.log(
        "EVIDENCE F2 bill POST count (expected 1):",
        billCalls.filter((m) => m === "POST").length,
      );
      console.log(
        "EVIDENCE F2 service-request API calls:",
        JSON.stringify(serviceRequestApiCalls),
      );
      console.log(
        "EVIDENCE F2 payment API calls (expected 0):",
        paymentCalls.length,
      );
    });
  });

  // Track F3 (UI8-B6.3): after the real 200, the UI must treat ONLY the
  // server-returned bill as authority ("Bill requested" + server totals) and
  // visibly freeze ordering at that same moment — without entering any payment
  // flow. No payment, no PAYMENT_PENDING transition, no readback.
  test.describe("Track F3 (UI8-B6.3)", () => {
    test.use({ viewport: { width: 375, height: 844 } });

    test("Track F3: real 200 -> authoritative bill display + ordering freeze, no payment", async ({
      page,
    }) => {
      const fmtINR = (n: number) =>
        new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(n);

      // ---------- PREREQUISITE: accepted F2 flow (order -> ACTIVE, billable) ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      // Track-D order: Chicken qty2 -> item_subtotal 440 -> session ACTIVE.
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await page.getByRole("button", { name: "Increase Chicken Biryani" }).click();
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByText("Order placed")).toBeVisible({ timeout: 15_000 });
      expect(orderCalls.length).toBe(1);

      // Pre-existing UNSUBMITTED selection present (item 8 precondition):
      // re-add Chicken qty1 -> the confirmation must clear it on success.
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveText("1");
      await expect(page.getByText("1 item selected")).toBeVisible();
      await expect(page.getByText(`Estimated total: ${fmtINR(220)}`)).toBeVisible();

      // ---------- OPEN CONFIRMATION + SUBMIT ----------
      await expect(page.getByRole("button", { name: "Request bill" })).toBeVisible();
      await page.getByRole("button", { name: "Request bill" }).click();
      const dialog = page.getByRole("dialog", { name: "Request the bill" });
      await expect(dialog).toBeVisible();

      // Delay the REAL 200 response so submitting AND success are observable.
      await page.route("**/api/v1/dine-in/sessions/*/bill", async (route) => {
        if (route.request().method() === "POST") {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await route.continue();
      });
      await dialog.getByRole("button", { name: "Request bill" }).click();
      await expect(dialog.getByRole("button", { name: "Requesting bill..." })).toBeVisible();

      // ---------- SUCCESS DOM MUTATION: Requesting... -> Bill requested ----------
      const billCard = page.getByRole("status").filter({ hasText: "Bill requested" });
      await expect(billCard).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByRole("button", { name: "Requesting bill..." })).toHaveCount(0);
      await expect(page.getByText("Bill requested")).toBeVisible();

      // ---------- AUTHORITATIVE BILL RESPONSE ----------
      await expect.poll(() => billResp.length).toBe(1);
      const br = billResp[0];
      expect(br.sessionStatus).toBe("BILL_REQUESTED");
      expect(br.foodSubtotal).toBe(440);
      expect(br.gstFood).toBe(22);
      expect(br.packagingFee).toBe(0);
      expect(br.gstPackaging).toBe(0);
      expect(br.totalAmount).toBe(462);
      await expect.poll(() => billRequests[0]?.status).toBe(200);

      // ---------- BILL DISPLAY PROOF (server values only) ----------
      await billCard.scrollIntoViewIfNeeded();
      await expect(billCard.getByText("Food subtotal")).toBeVisible();
      await expect(billCard.getByText(fmtINR(440))).toBeVisible();
      await expect(billCard.getByText("GST", { exact: true })).toBeVisible();
      await expect(billCard.getByText(fmtINR(22))).toBeVisible();
      await expect(billCard.getByText("Total", { exact: true })).toBeVisible();
      // "Total" equals the returned total_amount (462), NOT a client guess.
      await expect(billCard.getByText(fmtINR(462))).toBeVisible();

      // ---------- SELECTION CLEAR PROOF ----------
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveCount(0);
      await expect(page.getByText("1 item selected")).toHaveCount(0);
      await expect(page.getByText(`Estimated total: ${fmtINR(220)}`)).toHaveCount(0);

      // ---------- ORDERING FREEZE PROOF ----------
      await expect(page.getByRole("button", { name: "Add Chicken Biryani" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add Veg Biryani" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Increase Chicken Biryani" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Decrease Chicken Biryani" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);

      // ---------- MENU REMAINS READABLE ----------
      await page.getByText("Veg Biryani").scrollIntoViewIfNeeded();
      await expect(page.getByText("Chicken Biryani").first()).toBeVisible();
      await expect(page.getByText("Veg Biryani")).toBeVisible();

      // ---------- NO PAYMENT / PAID UI ----------
      await expect(page.getByRole("button", { name: /Pay/i })).toHaveCount(0);
      expect((await page.evaluate(() => document.body.innerText)).toLowerCase()).not.toContain("paid");

      // ---------- BRING_BILL / POST-SUCCESS NETWORK BOUNDARY ----------
      expect(serviceCalls.length).toBe(0);
      expect(serviceRequestApiCalls.length).toBe(0);
      expect(billCalls.filter((m) => m === "POST").length).toBe(1); // no extra bill POST
      expect(orderCalls.length).toBe(1); // Track-D prerequisite only
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- VISUAL F3: frozen success state ----------
      await page.screenshot({
        path: "test-results/evidence/track-f3-frozen.png",
        fullPage: true,
      });

      // ---------- CONTEXT / TOKEN CHECK ----------
      expect(new URL(page.url()).pathname).toBe("/dine-in/menu");
      expect(new URL(page.url()).search).toBe("");
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      const bodyF3 = await page.evaluate(() => document.body.innerText);
      expect(bodyF3).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE F3 bill response (sessionStatus, foodSubtotal, gstFood, packagingFee, gstPackaging, totalAmount):",
        JSON.stringify(
          billResp.map((b) => [
            b.sessionStatus,
            b.foodSubtotal,
            b.gstFood,
            b.packagingFee,
            b.gstPackaging,
            b.totalAmount,
          ]),
        ),
      );
      console.log(
        "EVIDENCE F3 service-request API calls:",
        JSON.stringify(serviceRequestApiCalls),
      );
      console.log(
        "EVIDENCE F3 bill POST count (expected 1):",
        billCalls.filter((m) => m === "POST").length,
      );
      console.log(
        "EVIDENCE F3 add/stepper/CTA present counts (Chicken add, stepper, Place order):",
        await page.getByRole("button", { name: "Add Chicken Biryani" }).count(),
        await page.getByRole("button", { name: "Increase Chicken Biryani" }).count(),
        await page.getByRole("button", { name: "Place order" }).count(),
      );
    });
  });

  // Track G1 (UI8-B7.1): UI7-B Repair A — with a selection present, the fixed
  // Place-order bar must never cover the LAST menu card on a narrow mobile
  // viewport: at absolute bottom scroll, lastCard.bottom <= orderBar.top. The
  // bottom spacer exists ONLY while a selection exists. Dialog/focus/Escape
  // checks are NOT part of this part.
  test.describe("Track G1 (UI8-B7.1)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("Track G1: last item scrolls fully above fixed order bar (Repair A), spacer conditional", async ({
      page,
    }) => {
      // ---------- SETUP: accepted authenticated loaded menu on narrow mobile ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Veg Biryani")).toBeVisible();
      expect(new URL(page.url()).search).toBe("");

      // Baseline: zero mutation of any kind.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(orderCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      // ---------- ORDER BAR VISIBILITY ----------
      await page.getByRole("button", { name: "Add Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveText("1");
      await expect(page.getByText("1 item selected")).toBeVisible();
      await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();

      // ---------- SPACER PRESENT WHILE SELECTION EXISTS ----------
      const spacer = page.getByTestId("dine-in-menu-bottom-spacer");
      await expect(spacer).toHaveCount(1);
      const spacerWithSelection = await spacer.count();

      // ---------- SCROLL TO ABSOLUTE BOTTOM + OCCLUSION PROOF ----------
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const vegCard = page.locator(".surface-card").filter({ hasText: "Veg Biryani" });
      const orderBar = page.locator("div.fixed.bottom-0");
      const vegBox = await vegCard.boundingBox();
      const barBox = await orderBar.boundingBox();
      expect(vegBox).not.toBeNull();
      expect(barBox).not.toBeNull();
      // Decisive invariant: the last menu card clears the fixed order bar.
      expect(vegBox!.y + vegBox!.height).toBeLessThanOrEqual(barBox!.y + 8);
      // CTA stays visible (not covered) at the same time.
      await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();

      // ---------- VISUAL G1: bottom of menu, CTA visible, last card unobscured ----------
      await page.screenshot({
        path: "test-results/evidence/track-g1-bottom-occlusion.png",
      });

      // ---------- REMOVE SELECTION ----------
      await page.getByRole("button", { name: "Decrease Chicken Biryani" }).click();
      await expect(page.getByLabel("Chicken Biryani quantity")).toHaveCount(0);

      // ---------- ORDER BAR DISAPPEARS ----------
      await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
      await expect(page.getByText("1 item selected")).toHaveCount(0);

      // ---------- SPACER REMOVED ----------
      await expect(spacer).toHaveCount(0);

      // ---------- OVERFLOW / BOTTOMNAV CHECK ----------
      await assertNoHorizontalOverflow(page);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

      // ---------- NETWORK BOUNDARY ----------
      expect(apiCalls.length).toBe(apiCallCountBaseline);
      expect(orderCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE G1 boxes (lastCardBottom, orderBarTop):",
        JSON.stringify([Math.round(vegBox!.y + vegBox!.height), Math.round(barBox!.y)]),
      );
      console.log(
        "EVIDENCE G1 spacer count with selection / after removal:",
        spacerWithSelection,
        await spacer.count(),
      );
      console.log(
        "EVIDENCE G1 api request delta during interactions:",
        apiCalls.length - apiCallCountBaseline,
      );
    });
  });

  // Track G2 (UI8-B7.2): UI7-B Repair C/B for the SERVICE dialog on a short
  // mobile viewport — viewport-constrained + internally scrollable, initial
  // focus inside, Tab/Shift+Tab containment, Escape-to-close with focus
  // restore to the trigger, body scroll lock/unlock, and the OTHER note
  // textarea reachable (maxlength 500). No service POST.
  test.describe("Track G2 (UI8-B7.2)", () => {
    test.use({ viewport: { width: 375, height: 480 } });

    test("Track G2: service dialog usable/scrollable on short viewport, focus/Escape/scroll-lock", async ({
      page,
    }) => {
      // ---------- SETUP: accepted authenticated loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      // Baseline: zero mutation.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      const vh = 480;
      const trigger = page.getByRole("button", { name: "Need something?" });

      // ---------- OPEN + VIEWPORT CONSTRAINT ----------
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Request something" });
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      // max-height calc(100dvh - 1rem) is respected on the short viewport.
      expect(dialogBox!.height).toBeLessThanOrEqual(vh - 16 + 1);

      // ---------- INITIAL FOCUS PROOF (dialog on first open) ----------
      // The first focusable in the dialog is the Close button.
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

      // ---------- BODY SCROLL LOCK PROOF ----------
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

      // ---------- FOCUS TRAP PROOF ----------
      // Last focusable (Other action tile) -> Tab wraps to first (Close).
      await dialog.getByRole("button", { name: "Other" }).focus();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
      // First focusable (Close) -> Shift+Tab wraps to last (Other).
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Other" })).toBeFocused();

      // ---------- VISUAL G2: open dialog on short viewport ----------
      await page.screenshot({
        path: "test-results/evidence/track-g2-dialog-open.png",
      });

      // ---------- HEIGHT / INTERNAL SCROLL PROOF ----------
      // Select "Other" so the dialog content (note textarea) exceeds max-height
      // on this short viewport, forcing the panel's internal overflow to engage.
      await dialog.getByRole("button", { name: "Other" }).click();
      const dims = await dialog.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          overflowY: cs.overflowY,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
        };
      });
      expect(dims.overflowY).toBe("auto");
      // Content overflows the constrained panel -> internal scroll is available.
      expect(dims.scrollHeight).toBeGreaterThan(dims.clientHeight);

      // ---------- ESCAPE / FOCUS RESTORE PROOF (while idle) ----------
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // Body scroll restored.
      await expect
        .poll(() => page.evaluate(() => document.body.style.overflow))
        .toBe("");

      // ---------- RE-OPEN -> OTHER TEXTAREA REACHABILITY ----------
      await trigger.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Other" }).click();
      const note = dialog.locator("#service-note");
      await expect(note).toBeVisible();
      await expect(note).toHaveAttribute("maxlength", "500");
      await note.click();
      await expect(note).toBeFocused();
      await note.fill("extra forks, thank you");
      await expect(note).toHaveValue("extra forks, thank you");

      // ---------- VISUAL G2: open dialog + Other textarea on short viewport ----------
      await note.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: "test-results/evidence/track-g2-other-note.png",
      });

      // ---------- NETWORK BOUNDARY ----------
      expect(apiCalls.length).toBe(apiCallCountBaseline);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(billCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE G2 dialog dims (overflowY, clientHeight, scrollHeight):",
        JSON.stringify([dims.overflowY, dims.clientHeight, dims.scrollHeight]),
      );
      console.log(
        "EVIDENCE G2 dialog box height vs viewport-16:",
        Math.round(dialogBox!.height),
        vh - 16,
      );
      console.log(
        "EVIDENCE G2 api request delta during interactions:",
        apiCalls.length - apiCallCountBaseline,
      );
    });
  });

  // Track H (UI8-B7.3): UI7-B Repair C/B for the BILL confirmation dialog on
  // a short mobile viewport — viewport-constrained, internally scrollable if
  // content ever exceeds, initial focus inside, Tab/Shift+Tab containment,
  // Escape-to-close with focus restore to the "Request bill" trigger, body
  // scroll lock/unlock, clean re-open, confirm + "Keep ordering" CTAs
  // reachable. NO bill POST / payment / service / order mutation.
  test.describe("Track H (UI8-B7.3)", () => {
    test.use({ viewport: { width: 375, height: 480 } });

    test("Track H: bill confirmation dialog usable/scrollable on short viewport, focus/Escape/scroll-lock", async ({
      page,
    }) => {
      // ---------- SETUP: accepted authenticated loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      // Baseline: zero mutation.
      expect(menuRequests.length).toBe(1);
      expect(sessionPosts.length).toBe(1);
      expect(billCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      const apiCallCountBaseline = apiCalls.length;

      const vh = 480;
      // While the dialog is closed the only "Request bill" button is the
      // shell trigger; once open, the confirm CTA (same name) is scoped below.
      const trigger = page.getByRole("button", { name: "Request bill" });

      // ---------- OPEN + VIEWPORT CONSTRAINT ----------
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Request the bill" });
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      // max-height calc(100dvh - 1rem) is respected on the short viewport.
      expect(dialogBox!.height).toBeLessThanOrEqual(vh - 16 + 1);

      // ---------- HEIGHT / INTERNAL SCROLL MECHANISM PROOF ----------
      // The confirmation content is compact, so on 480 it fits without needing
      // internal scroll; the machinery (max-h calc(100dvh-1rem) + overflow-y
      // auto) must still be present so scroll engages the moment content
      // exceeds the viewport.
      const dims = await dialog.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          overflowY: cs.overflowY,
          maxHeight: cs.maxHeight,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
        };
      });
      expect(dims.overflowY).toBe("auto");
      expect(dims.maxHeight).toBe(`${vh - 16}px`);
      // No truncation at this viewport: content fits and nothing is clipped.
      expect(dims.scrollHeight).toBeLessThanOrEqual(dims.clientHeight);

      // ---------- INITIAL FOCUS PROOF ----------
      // The first focusable in the dialog is the Close button.
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

      // ---------- VISUAL H: open short-viewport confirmation dialog ----------
      await page.screenshot({
        path: "test-results/evidence/track-h-confirmation.png",
      });

      // ---------- BODY SCROLL LOCK PROOF ----------
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

      // ---------- FOCUS TRAP PROOF ----------
      // Last focusable (Keep ordering) -> Tab wraps to first (Close).
      await dialog.getByRole("button", { name: "Keep ordering" }).focus();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
      // First focusable (Close) -> Shift+Tab wraps to last (Keep ordering).
      await page.keyboard.press("Shift+Tab");
      await expect(
        dialog.getByRole("button", { name: "Keep ordering" }),
      ).toBeFocused();

      // ---------- ESCAPE / FOCUS RESTORE PROOF ----------
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // Body scroll restored.
      await expect
        .poll(() => page.evaluate(() => document.body.style.overflow))
        .toBe("");

      // ---------- RE-OPEN + CTA REACHABILITY ----------
      await trigger.click();
      await expect(dialog).toBeVisible();
      // Clean re-open: initial focus returns to the first focusable.
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
      const confirmCta = dialog.getByRole("button", { name: "Request bill" });
      const keepOrdering = dialog.getByRole("button", { name: "Keep ordering" });
      await expect(confirmCta).toBeVisible();
      await expect(confirmCta).toBeEnabled();
      await confirmCta.scrollIntoViewIfNeeded();
      await expect(keepOrdering).toBeVisible();
      await expect(keepOrdering).toBeEnabled();
      await keepOrdering.scrollIntoViewIfNeeded();

      // ---------- SECONDARY CLOSE PATH (Keep ordering, no POST) ----------
      await keepOrdering.click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // ---------- NETWORK BOUNDARY ----------
      expect(apiCalls.length).toBe(apiCallCountBaseline);
      expect(billCalls.length).toBe(0);
      expect(serviceCalls.length).toBe(0);
      expect(orderCalls.length).toBe(0);
      expect(cartCalls.length).toBe(0);
      expect(sessionPosts.length).toBe(1);

      // ---------- CONTEXT / TOKEN ABSENCE ----------
      // Rendered text must not leak the fixture token or internal ids.
      const bodyText = await page.evaluate(() => document.body.innerText);
      for (const secret of [
        DINE_IN_FIXTURE_TABLE_TOKEN,
        DINE_IN_FIXTURE_RESTAURANT_ID,
        DINE_IN_FIXTURE_TABLE_ID,
      ]) {
        expect(bodyText.includes(secret)).toBe(false);
      }

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE H dialog dims (overflowY, maxHeight, clientHeight, scrollHeight):",
        JSON.stringify([dims.overflowY, dims.maxHeight, dims.clientHeight, dims.scrollHeight]),
      );
      console.log(
        "EVIDENCE H dialog box height vs viewport-16:",
        Math.round(dialogBox!.height),
        vh - 16,
      );
      console.log(
        "EVIDENCE H api request delta during interactions:",
        apiCalls.length - apiCallCountBaseline,
      );
      console.log("EVIDENCE H token/id leak check: clean");
    });
  });

  // Track H-1 (UI8-B8.1): cold reload of /dine-in/menu must NOT fabricate a
  // session/menu from the wiped in-memory Zustand context. It must show the
  // explicit safe fallback (unavailable + scan-table-QR guidance), make no
  // automatic session/menu/order/service/bill/cart calls after reload, keep the
  // token out of the URL and rendered text, and offer a usable re-scan action.
  test.describe("Track H-1 (UI8-B8.1)", () => {
    test("Track H-1: cold reload /dine-in/menu -> safe-fail to re-scan, no fabricated session, no auto mutation", async ({
      page,
    }) => {
      // ---------- PRE-RELOAD STATE: accepted authenticated loaded menu ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Dine-In Menu")).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_RESTAURANT_NAME).first()).toBeVisible();
      await expect(page.getByText(DINE_IN_FIXTURE_TABLE_LABEL).first()).toBeVisible();
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Need something?" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Request bill" })).toBeVisible();
      // Menu URL is token-free before reload.
      expect(page.url()).not.toContain("table=");

      // Baseline mutation counts (nothing further may move after reload).
      const sessionPostsBefore = sessionPosts.length;
      const menuRequestsBefore = menuRequests.length;
      const resolveCallsBefore = resolveCalls.length;
      const orderCallsBefore = orderCalls.length;
      const serviceCallsBefore = serviceCalls.length;
      const billCallsBefore = billCalls.length;
      const cartCallsBefore = cartCalls.length;
      const apiBaseline = apiCalls.length;

      // ---------- RELOAD INTERACTION ----------
      await page.reload({ waitUntil: "load" });

      // ---------- SAFE-FAIL DOM PROOF ----------
      await expect(page.getByText("Dine-in session unavailable")).toBeVisible({
        timeout: 15_000,
      });
      // The empty Next.js route-announcer also carries role=alert, so scope to
      // the alert that actually contains the guidance.
      await expect(
        page.getByRole("alert").filter({ hasText: /Scan the table QR again/ }),
      ).toBeVisible();

      // ---------- NO-FABRICATED-SESSION PROOF ----------
      // No menu/session restored as if it persisted.
      await expect(page.getByText("Dine-In Menu")).not.toBeVisible();
      await expect(page.getByText("Chicken Biryani")).toHaveCount(0);
      await expect(page.getByText("Ready to order")).toHaveCount(0);
      await expect(page.getByText("Session ready")).toHaveCount(0);
      // No Add/Place-order controls.
      await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
      // No bill/service states.
      await expect(page.getByText("Bill requested")).toHaveCount(0);
      await expect(page.getByText("Request sent")).toHaveCount(0);

      // ---------- NETWORK BOUNDARY ----------
      // No automatic session/menu/order/service/bill/cart call after reload.
      expect(sessionPosts.length).toBe(sessionPostsBefore);
      expect(menuRequests.length).toBe(menuRequestsBefore);
      expect(resolveCalls.length).toBe(resolveCallsBefore);
      expect(orderCalls.length).toBe(orderCallsBefore);
      expect(serviceCalls.length).toBe(serviceCallsBefore);
      expect(billCalls.length).toBe(billCallsBefore);
      expect(cartCalls.length).toBe(cartCallsBefore);

      // ---------- TOKEN / DATA BOUNDARY ----------
      expect(page.url()).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
      expect(page.url()).not.toContain("table=");
      const bodyText = await page.evaluate(() => document.body.innerText);
      for (const secret of [
        DINE_IN_FIXTURE_TABLE_TOKEN,
        DINE_IN_FIXTURE_RESTAURANT_ID,
        DINE_IN_FIXTURE_TABLE_ID,
      ]) {
        expect(bodyText.includes(secret)).toBe(false);
      }

      // ---------- VISUAL SNAPSHOT ----------
      await page.screenshot({
        path: "test-results/evidence/track-h1-safe-fail.png",
      });

      // ---------- RE-SCAN ACTION ----------
      const rescan = page.getByRole("link", { name: "Scan table QR again" });
      await expect(rescan).toBeVisible();
      await expect(rescan).toBeEnabled();
      await expect(rescan).toHaveAttribute("href", "/dine-in");
      // Usable: navigates to the token-free QR entry; a session is NOT reopened.
      await rescan.click();
      await page.waitForURL(
        (url) => url.pathname === "/dine-in" && !url.searchParams.has("table"),
      );
      // Resolver shows the missing-token re-scan guidance (no API call).
      await expect(page.getByText("Invalid table QR")).toBeVisible();
      expect(sessionPosts.length).toBe(sessionPostsBefore);

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE H1 post-reload session/menu/resolve/order/service/bill/cart deltas:",
        JSON.stringify([
          sessionPosts.length - sessionPostsBefore,
          menuRequests.length - menuRequestsBefore,
          resolveCalls.length - resolveCallsBefore,
          orderCalls.length - orderCallsBefore,
          serviceCalls.length - serviceCallsBefore,
          billCalls.length - billCallsBefore,
          cartCalls.length - cartCallsBefore,
        ]),
      );
      console.log(
        "EVIDENCE H1 raw api delta after reload (auth may refresh; no mutation):",
        apiCalls.length - apiBaseline,
      );
      console.log("EVIDENCE H1 token/id leak check: clean");
    });
  });

  // Track H-2 (UI8-B8.2): from the accepted cold-reload safe-fail state, the
  // re-scan action must lead to the token-free /dine-in entry showing the safe
  // missing-token "Invalid table QR" guidance, with zero resolve/session/order/
  // service/bill/cart calls, and browser back/forward must NEVER resurrect the
  // stale in-memory session (menu stays absent).
  test.describe("Track H-2 (UI8-B8.2)", () => {
    test("Track H-2: re-scan/re-entry from safe-fail -> invalid-QR guidance, back/forward cannot resurrect stale session", async ({
      page,
    }) => {
      // ---------- SETUP: reach the accepted H1 safe-fail state ----------
      await openSessionReady(page);
      await page.getByRole("button", { name: /View Menu/ }).click();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Chicken Biryani")).toBeVisible({ timeout: 15_000 });

      const sessionPostsBefore = sessionPosts.length;
      const resolveCallsBefore = resolveCalls.length;
      const menuRequestsBefore = menuRequests.length;
      const orderCallsBefore = orderCalls.length;
      const serviceCallsBefore = serviceCalls.length;
      const billCallsBefore = billCalls.length;
      const cartCallsBefore = cartCalls.length;

      await page.reload({ waitUntil: "load" });
      await expect(page.getByText("Dine-in session unavailable")).toBeVisible({
        timeout: 15_000,
      });
      // The empty Next.js route-announcer also carries role=alert, so scope to
      // the alert that actually contains the guidance.
      await expect(
        page.getByRole("alert").filter({ hasText: /Scan the table QR again/ }),
      ).toBeVisible();

      // ---------- RE-SCAN INTERACTION ----------
      const rescan = page.getByRole("link", { name: "Scan table QR again" });
      await expect(rescan).toBeVisible();
      await rescan.click();
      await page.waitForURL(
        (url) => url.pathname === "/dine-in" && !url.searchParams.has("table"),
      );

      // ---------- RE-ENTRY DOM PROOF ----------
      // No stale session/menu UI remains on the entry landing.
      await expect(page.getByText("Dine-In Menu")).toHaveCount(0);
      await expect(page.getByText("Chicken Biryani")).toHaveCount(0);
      await expect(page.getByText("Dine-in session unavailable")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Need something?" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Request bill" })).toHaveCount(0);
      // Missing-token state shows the safe guidance.
      await expect(page.getByText("Invalid table QR")).toBeVisible();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: /Scan the QR code on your table/ }),
      ).toBeVisible();

      // ---------- NETWORK BOUNDARY ----------
      // No resolve call with an empty token; no POST /sessions; no mutation.
      expect(resolveCalls.length).toBe(resolveCallsBefore);
      expect(sessionPosts.length).toBe(sessionPostsBefore);
      expect(menuRequests.length).toBe(menuRequestsBefore);
      expect(orderCalls.length).toBe(orderCallsBefore);
      expect(serviceCalls.length).toBe(serviceCallsBefore);
      expect(billCalls.length).toBe(billCallsBefore);
      expect(cartCalls.length).toBe(cartCallsBefore);

      // ---------- TOKEN / DATA BOUNDARY ----------
      expect(page.url()).not.toContain(DINE_IN_FIXTURE_TABLE_TOKEN);
      expect(page.url()).not.toContain("table=");
      let bodyText = await page.evaluate(() => document.body.innerText);
      for (const secret of [
        DINE_IN_FIXTURE_TABLE_TOKEN,
        DINE_IN_FIXTURE_RESTAURANT_ID,
        DINE_IN_FIXTURE_TABLE_ID,
      ]) {
        expect(bodyText.includes(secret)).toBe(false);
      }

      // ---------- VISUAL SNAPSHOT: re-entry landing ----------
      await page.screenshot({
        path: "test-results/evidence/track-h2-reentry.png",
      });

      // ---------- STALE-STATE NON-RESURRECTION ----------
      // Browser back to /dine-in/menu must show safe-fail, NOT the menu.
      await page.goBack();
      await page.waitForURL((url) => url.pathname === "/dine-in/menu");
      await expect(page.getByText("Dine-in session unavailable")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText("Dine-In Menu")).toHaveCount(0);
      await expect(page.getByText("Chicken Biryani")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
      // Browser forward back to the token-free entry.
      await page.goForward();
      await page.waitForURL((url) => url.pathname === "/dine-in");
      await expect(page.getByText("Invalid table QR")).toBeVisible();
      await expect(page.getByText("Dine-In Menu")).toHaveCount(0);

      // Still zero mutations across the navigation.
      expect(sessionPosts.length).toBe(sessionPostsBefore);
      expect(resolveCalls.length).toBe(resolveCallsBefore);
      expect(menuRequests.length).toBe(menuRequestsBefore);
      expect(orderCalls.length).toBe(orderCallsBefore);
      expect(serviceCalls.length).toBe(serviceCallsBefore);
      expect(billCalls.length).toBe(billCallsBefore);
      expect(cartCalls.length).toBe(cartCallsBefore);

      // Token-free and id-free after back/forward too.
      expect(page.url()).not.toContain("table=");
      bodyText = await page.evaluate(() => document.body.innerText);
      for (const secret of [
        DINE_IN_FIXTURE_TABLE_TOKEN,
        DINE_IN_FIXTURE_RESTAURANT_ID,
        DINE_IN_FIXTURE_TABLE_ID,
      ]) {
        expect(bodyText.includes(secret)).toBe(false);
      }

      // ---------- SANITIZED EVIDENCE SUMMARY ----------
      console.log(
        "EVIDENCE H2 resolve/session/menu/order/service/bill/cart deltas:",
        JSON.stringify([
          resolveCalls.length - resolveCallsBefore,
          sessionPosts.length - sessionPostsBefore,
          menuRequests.length - menuRequestsBefore,
          orderCalls.length - orderCallsBefore,
          serviceCalls.length - serviceCallsBefore,
          billCalls.length - billCallsBefore,
          cartCalls.length - cartCallsBefore,
        ]),
      );
      console.log("EVIDENCE H2 token/id leak check: clean");
    });
  });
});
