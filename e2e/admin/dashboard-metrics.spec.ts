import { test, expect, type Page } from "@playwright/test";
import { adminLogin } from "../helpers/admin";
import { SEEDED_ADMIN_EMAIL } from "../helpers/constants";

// ============================================================
// Dashboard metrics truth (ADMIN-PLATFORM-TRUTH-A2 / B1F1)
//
// Assertions compare the rendered dashboard against the live
// /api/v1/admin/metrics payload (the backend is the oracle), so the
// spec never hard-codes a fabricated total — it cross-checks the UI
// to the repository-derived numbers instead.
//
// Headline and series locators are scoped to their semantic UI
// region (the stat card that carries the matching label, and the
// 7-day series panel), because the same currency value legitimately
// appears in the headline card and in series rows. Scoping expresses
// *which* element is asserted instead of relying on a page-unique
// rendered value (B1F1 repair; the unscoped form was strict-mode
// ambiguous under any payload).
//
// Admin auth is cookie-based, so `page.request` shares the browser
// session and can read /metrics without a separate login.
// ============================================================

interface MetricsPayload {
  revenue_today: number;
  fulfilled_orders_today: number;
  active_orders: number;
  daily_series: { date: string; revenue: number; fulfilled_orders: number }[];
}

async function readMetrics(page: Page): Promise<MetricsPayload> {
  const res = await page.request.get("/api/v1/admin/metrics");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data as MetricsPayload;
}

function istToday(): string {
  // Fixed +05:30 IST date key, mirroring the service's IST_OFFSET_MS.
  const shifted = new Date(Date.now() + 330 * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

// Headline stat cards and the 7-day series panel all share the
// `rounded-xl border` surface, and the same value can legitimately
// appear in the headline card AND in series rows. Every value
// assertion is therefore scoped to its semantic region:
//  - stat card: the surface containing the exact card label, then the
//    bold value line within it;
//  - series: the surface headed by the series title, then its rows.
function statCard(page: Page, label: string) {
  return page
    .locator("div.rounded-xl.border")
    .filter({ has: page.getByText(label, { exact: true }) });
}

function statValue(page: Page, label: string) {
  return statCard(page, label).locator("p.font-bold");
}

function seriesPanel(page: Page) {
  return page
    .locator("div.rounded-xl.border")
    .filter({ has: page.getByText(/Revenue — last 7 days/) });
}

function seriesRows(page: Page) {
  return seriesPanel(page).locator("div.space-y-2 > div");
}

test.describe("admin dashboard metrics truth", () => {
  test("renders exactly the /metrics payload with an honest IST series", async ({ page }) => {
    await adminLogin(page, SEEDED_ADMIN_EMAIL);

    const m = await readMetrics(page);
    const today = istToday();

    // Card labels are real, placement-day semantics surfaced, no fabricated KPIs.
    await expect(page.getByText("Today's Revenue")).toBeVisible();
    await expect(page.getByText("Fulfilled Orders Today")).toBeVisible();
    await expect(page.getByText("Active Orders")).toBeVisible();

    // Every headline card value equals the backend payload. Each assertion
    // is scoped to the card that carries its label (bold value line), so an
    // identical series-row value can never satisfy the headline check.
    await expect(statValue(page, "Today's Revenue")).toHaveText(inr(m.revenue_today));
    await expect(statValue(page, "Fulfilled Orders Today")).toHaveText(
      String(m.fulfilled_orders_today),
    );
    await expect(statValue(page, "Active Orders")).toHaveText(String(m.active_orders));

    // Series is exactly the payload's seven IST buckets, ending on today,
    // and each rendered row equals the backend value (zeros render as ₹0).
    const rows = seriesRows(page);
    await expect(rows).toHaveCount(m.daily_series.length);

    const dates = await rows.locator("span.font-mono").allTextContents();
    const values = await rows.locator("span.font-semibold").allTextContents();
    expect(dates.map((d) => d.trim())).toEqual(m.daily_series.map((p) => p.date));
    expect(values.map((v) => v.trim())).toEqual(m.daily_series.map((p) => inr(p.revenue)));

    // Shared denominator honesty: the last (today) bucket must equal the
    // today headline pair, and no fabricated trend is rendered anywhere.
    const last = m.daily_series[m.daily_series.length - 1];
    expect(last.date).toBe(today);
    expect(last.revenue).toBe(m.revenue_today);
    expect(last.fulfilled_orders).toBe(m.fulfilled_orders_today);

    for (const gone of [
      "Vendor Churn",
      "Webhook Failures",
      "Avg Pickup Time",
      "CAC (per user)",
      "LTV (6 mo est.)",
      "CAC / LTV Ratio",
      "Daily Revenue",
      "Orders Today",
    ]) {
      await expect(page.getByText(gone, { exact: true })).toHaveCount(0);
    }
  });

  test("dashboard totals persist across reload (state persistence)", async ({ page }) => {
    await adminLogin(page, SEEDED_ADMIN_EMAIL);
    const m = await readMetrics(page);

    await expect(statValue(page, "Today's Revenue")).toHaveText(inr(m.revenue_today));

    // Count in-page /metrics GETs so reload freshness is proven by the page
    // itself emitting a new request (not by the oracle re-read below).
    let metricsGets = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/v1/admin/metrics")) metricsGets += 1;
    });
    const before = metricsGets;

    await page.reload();
    await expect(page.getByText("Today's Revenue")).toBeVisible();
    await expect(statValue(page, "Today's Revenue")).toHaveText(inr(m.revenue_today));
    await expect(statValue(page, "Fulfilled Orders Today")).toHaveText(
      String(m.fulfilled_orders_today),
    );
    await expect(statValue(page, "Active Orders")).toHaveText(String(m.active_orders));

    // The reload must have issued its own fresh /metrics request.
    expect(metricsGets).toBeGreaterThan(before);

    // A second oracle read after reload must match the first (no drift into
    // fabricated values on re-render).
    const m2 = await readMetrics(page);
    expect(m2.revenue_today).toBe(m.revenue_today);
    expect(m2.daily_series).toEqual(m.daily_series);
  });
});
