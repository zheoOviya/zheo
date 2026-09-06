import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import VendorBillDetailPage from "../page";
import type { VendorBillDetail, VendorBillTotalsDTO } from "@/lib/api";
import { formatINR, shortOrderId } from "@/lib/format";

const BILL_ID = "bill-0000-0000-0000-0000b1b10001";
const BILL_SHORT = shortOrderId(BILL_ID);
const SESSION_ID = "session-0000-0000-0000-0000aa990011";

const mocks = vi.hoisted(() => ({
  fetchVendorBillDetail: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchVendorBillDetail: mocks.fetchVendorBillDetail,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ billId: BILL_ID }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function billTotals(overrides: Partial<VendorBillTotalsDTO> = {}): VendorBillTotalsDTO {
  return {
    id: BILL_ID,
    session_id: SESSION_ID,
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    food_subtotal: 200,
    packaging_fee: 0,
    gst_food: 18,
    gst_packaging: 0,
    total_amount: 236,
    frozen_at: "2026-09-04T05:31:00.000Z",
    ...overrides,
  };
}

type LifecycleStatus = "PENDING" | "ACKNOWLEDGED" | "COMPLETED";

function billDetail(
  overrides: Partial<VendorBillDetail> & {
    lifecycle?: LifecycleStatus;
    zoneName?: string | null;
  } = {},
): VendorBillDetail {
  const lifecycle: LifecycleStatus = overrides.lifecycle ?? "PENDING";
  const zoneName: string | null = overrides.zoneName === undefined ? "Patio" : overrides.zoneName;
  return {
    bill: billTotals(),
    session: {
      id: SESSION_ID,
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-09-04T05:30:00.000Z",
      opened_at: "2026-09-04T05:00:00.000Z",
    },
    table: { id: "table-0000-0000-0000-000000000001", label: "T1" },
    zone: zoneName === null ? null : { id: "zone-0000-0000-0000-000000000001", name: zoneName },
    bring_bill_request:
      lifecycle === null
        ? null
        : {
            id: "req-0000-0000-0000-000000000001",
            status: lifecycle,
            acknowledged_at:
              lifecycle === "PENDING" ? null : "2026-09-04T05:32:00.000Z",
            completed_at: lifecycle === "COMPLETED" ? "2026-09-04T05:34:00.000Z" : null,
          },
    orders: [
      {
        id: "order-0000-0000-0000-000000000001",
        status: "SERVED",
        created_at: "2026-09-04T05:10:00.000Z",
        items: [{ name: "Butter Chicken", quantity: 2, item_subtotal: 160 }],
      },
    ],
    ...overrides,
  };
}

function apiError(message: string): Error {
  return new Error(message);
}

beforeEach(() => {
  mocks.fetchVendorBillDetail.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Vendor read-only bill detail", () => {
  it("fetches the detail for the route bill id", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail());

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Total")).toBeDefined();
    expect(mocks.fetchVendorBillDetail).toHaveBeenCalledWith(BILL_ID);
  });

  it("renders the frozen bill summary, items and authoritative totals", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail());

    render(<VendorBillDetailPage />);

    // The bill id heads both the page header and the summary section.
    await screen.findByText("Total");
    expect(
      screen.getAllByRole("heading", { name: `Bill #${BILL_SHORT}` }).length,
    ).toBeGreaterThan(0);
    // Status chip reflects the untouched PENDING lifecycle.
    expect(screen.getByText("Pending")).toBeDefined();
    // Frozen totals are shown verbatim from the wire.
    expect(screen.getByText("Food subtotal")).toBeDefined();
    expect(screen.getByText(formatINR(200))).toBeDefined();
    expect(screen.getByText("GST")).toBeDefined();
    expect(screen.getByText(formatINR(18))).toBeDefined();
    expect(screen.getByText("Total")).toBeDefined();
    expect(screen.getByText(formatINR(236))).toBeDefined();
    // No packaging line for a zero frozen fee.
    expect(screen.queryByText("Packaging fee")).toBeNull();
    // Order snapshot: name, quantity, subtotal.
    expect(screen.getByText("Butter Chicken")).toBeDefined();
    expect(screen.getByText("× 2")).toBeDefined();
    expect(screen.getByText(formatINR(160))).toBeDefined();
  });

  it("shows the zone in the header and summary when present", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail({ zoneName: "Patio" }));

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Total")).toBeDefined();
    expect(screen.getAllByText(/Patio/).length).toBeGreaterThan(0);
  });

  it("omits the zone entirely when the table has no zone", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail({ zoneName: null }));

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Total")).toBeDefined();
    expect(screen.queryByText(/Patio/)).toBeNull();
  });

  it("shows a packaging line only when the frozen fee is positive and sums GST", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(
      billDetail({
        bill: billTotals({
          food_subtotal: 200,
          packaging_fee: 20,
          gst_food: 18,
          gst_packaging: 4,
          total_amount: 242,
        }),
      }),
    );

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Packaging fee")).toBeDefined();
    expect(screen.getByText(formatINR(20))).toBeDefined();
    // The GST line is the sum of the frozen food + packaging GST.
    expect(screen.getByText(formatINR(22))).toBeDefined();
    // Authoritative total rendered verbatim (never re-derived).
    expect(screen.getByText(formatINR(242))).toBeDefined();
  });

  it("renders an acknowledged bill with its lifecycle stamps and no delivery banner", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(
      billDetail({ lifecycle: "ACKNOWLEDGED" }),
    );

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Acknowledged", { selector: "span" })).toBeDefined();
    expect(screen.queryByText("Pending", { selector: "span" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Acknowledged", { selector: "dt" })).toBeDefined();
  });

  it("marks a COMPLETED bill as Delivered with a read-only status banner", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail({ lifecycle: "COMPLETED" }));

    render(<VendorBillDetailPage />);

    expect(
      await screen.findByText(/Delivered to the table/i),
    ).toBeDefined();
    expect(screen.getByText("Delivered", { selector: "span" })).toBeDefined();
    expect(screen.getByText("Delivered", { selector: "dt" })).toBeDefined();
    // The acknowledged stamp stays on the completed record as lifecycle history.
    expect(screen.getByText("Acknowledged", { selector: "dt" })).toBeDefined();
    // The detail is read-only: no lifecycle mutation controls exist.
    expect(screen.queryByRole("button", { name: /Acknowledge|Mark delivered/i })).toBeNull();
  });

  it("renders a detail with no BRING_BILL artifact as a plain frozen snapshot", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(
      billDetail({ bring_bill_request: null, lifecycle: "PENDING" }),
    );

    render(<VendorBillDetailPage />);

    expect(await screen.findByText("Total")).toBeDefined();
    expect(screen.queryByText("Pending")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Acknowledged", { selector: "dt" })).toBeNull();
  });

  it("prints the bill through window.print and keeps controls out of the print region", async () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail({ lifecycle: "COMPLETED" }));

    render(<VendorBillDetailPage />);

    const printButton = await screen.findByRole("button", { name: "Print bill" });
    fireEvent.click(printButton);
    expect(printSpy).toHaveBeenCalledTimes(1);

    // The only print surface is the #bill-print-region anchor: it holds the
    // frozen bill content, and the header/nav/print controls live outside it.
    const region = document.getElementById("bill-print-region");
    if (!region) throw new Error("#bill-print-region missing");
    expect(within(region).getByText("Total")).toBeDefined();
    expect(within(region).queryByRole("link")).toBeNull();
    expect(within(region).queryByRole("button")).toBeNull();
    const back = screen.getByRole("link", { name: "Back to bills" });
    expect(back.getAttribute("href")).toBe("/dine-in/bills");
  });

  it("recovers from a failed fetch via the retry action", async () => {
    mocks.fetchVendorBillDetail
      .mockRejectedValueOnce(apiError("Bill not found"))
      .mockResolvedValueOnce(billDetail());

    render(<VendorBillDetailPage />);

    expect(await screen.findByText(/Couldn't load the bill/)).toBeDefined();
    expect(screen.getByText("Bill not found")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Total")).toBeDefined();
    await waitFor(() => expect(mocks.fetchVendorBillDetail).toHaveBeenCalledTimes(2));
  });

  it("never exposes settlement, payment, owner or token semantics on the detail", async () => {
    mocks.fetchVendorBillDetail.mockResolvedValue(billDetail({ lifecycle: "COMPLETED" }));

    render(<VendorBillDetailPage />);

    expect(await screen.findByText(/Delivered to the table/i)).toBeDefined();
    const body = document.body.textContent ?? "";
    for (const forbidden of [
      "Settle",
      "settle",
      "Paid",
      "Pay",
      "Close session",
      "Cancel",
      "Payment",
      "owner",
      "requested_by",
      "table_token",
    ]) {
      expect(body).not.toContain(forbidden);
    }
    expect(
      screen.queryByRole("button", { name: /acknowledge|deliver|settle|pay|close|cancel/i }),
    ).toBeNull();
  });
});

// The print CSS must be route-scoped: it may only affect this bill route (its
// only print surface is #bill-print-region), and it must never add a global
// "body *" print reset that would break printing on every other vendor route.
describe("bill print CSS scoping in app/globals.css", () => {
  const css = readFileSync(path.resolve(process.cwd(), "app/globals.css"), "utf8");

  it("anchors print rules to the #bill-print-region presence selector", () => {
    expect(css).toContain("body:has(#bill-print-region)");
  });

  it("keeps the print rules inside a @media print block", () => {
    const blockStart = css.indexOf("@media print");
    expect(blockStart).toBeGreaterThan(-1);
    const block = css.slice(blockStart);
    expect(block).toContain("body:has(#bill-print-region)");
  });

  it("scopes every print declaration behind the #bill-print-region presence gate", () => {
    // The only print block in the stylesheet must gate every rule with the
    // bill-route anchor so no other vendor route (header/nav/buttons included)
    // is affected when printing.
    const blockStart = css.indexOf("@media print");
    const block = css.slice(blockStart);
    const before = css.slice(0, blockStart);
    expect(before).not.toContain("@media print");
    const gateCount = (block.match(/body:has\(#bill-print-region\)/g) ?? []).length;
    // Three scoped rules: hide-all, re-show-region, absolutely position region.
    expect(gateCount).toBeGreaterThanOrEqual(3);
    // Nothing outside the gate may be hidden by the block.
    expect(block).not.toContain("body *");
    expect(block).not.toContain("body:has(#bill-print-region) header");
    expect(block).not.toContain("nav");
  });
});
