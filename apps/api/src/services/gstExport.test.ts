import { describe, expect, it } from "vitest";
import {
  buildGstCsv,
  csvEscape,
  gstMonthWindow,
  gstinForRestaurant,
  invoiceNumber,
  parseGstMonth,
  round2,
} from "./gstExport";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import { AppError } from "../middleware/envelope";

// ============================================
// GST Compliance Export (V12) unit tests
// ============================================

const REST: RestaurantDTO = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Biryani House",
  gst_number: "27AABCB1234A1Z5",
  commission_rate: 0.08,
  is_active: true,
  lat: 19.076,
  lng: 72.8777,
};

function makeOrder(
  id: string,
  createdAt: string,
  itemSubtotal: number,
  status: OrderDTO["status"] = "PICKED_UP",
): OrderDTO {
  const item: OrderItemDTO = {
    id: `itm-${id}`,
    menu_item_id: "b0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    base_price: itemSubtotal,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: itemSubtotal,
  };
  return {
    id,
    user_id: "u-1",
    restaurant_id: REST.id,
    items: [item],
    total_amount: itemSubtotal + 10,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("GST export helpers", () => {
  it("parseGstMonth accepts YYYY-MM and rejects anything else", () => {
    expect(parseGstMonth("2026-08")).toBe("2026-08");
    expect(() => parseGstMonth("2026-13")).toThrow(AppError);
    expect(() => parseGstMonth("2026-8")).toThrow(AppError);
    expect(() => parseGstMonth("Aug 2026")).toThrow(AppError);
    expect(() => parseGstMonth(undefined)).toThrow(AppError);
  });

  it("gstMonthWindow spans the exact calendar month", () => {
    const { startIso, endIso } = gstMonthWindow("2026-08");
    expect(startIso).toBe("2026-08-01T00:00:00.000Z");
    expect(endIso).toBe("2026-09-01T00:00:00.000Z");
  });

  it("gstinForRestaurant uses the stored GSTIN and falls back deterministically", () => {
    expect(gstinForRestaurant(REST)).toBe("27AABCB1234A1Z5");
    const fallback = gstinForRestaurant({ id: REST.id, gst_number: null });
    expect(fallback.startsWith("27MOCK")).toBe(true);
    expect(gstinForRestaurant({ id: REST.id, gst_number: null })).toBe(fallback);
  });

  it("invoice numbers are sequential per month", () => {
    expect(invoiceNumber(0, "2026-08")).toBe("INV-2026-08-0001");
    expect(invoiceNumber(9, "2026-08")).toBe("INV-2026-08-0010");
  });

  it("csvEscape quotes fields with commas or quotes", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape(220)).toBe("220");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("round2 keeps two decimals", () => {
    expect(round2(5.005)).toBe(5.01);
    expect(round2(5)).toBe(5);
  });
});

describe("buildGstCsv", () => {
  it("emits the GSTR-1 header and one row per eligible order", () => {
    const orders = [
      makeOrder("o1", "2026-08-04T10:00:00.000Z", 200),
      makeOrder("o2", "2026-08-05T11:00:00.000Z", 440),
    ];

    const csv = buildGstCsv(orders, REST, "2026-08");
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe(
      "Invoice No,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
    expect(lines).toHaveLength(3);

    // Row 1: taxable 200 -> CGST/SGST 5 each
    expect(lines[1]).toBe(
      "INV-2026-08-0001,27AABCB1234A1Z5,2026-08-04,200.00,5.00,5.00",
    );
    // Row 2: taxable 440 -> CGST/SGST 11 each
    expect(lines[2]).toBe(
      "INV-2026-08-0002,27AABCB1234A1Z5,2026-08-05,440.00,11.00,11.00",
    );
  });

  it("returns just the header when there are no orders", () => {
    const csv = buildGstCsv([], REST, "2026-08");
    expect(csv).toBe(
      "Invoice No,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
  });
});
