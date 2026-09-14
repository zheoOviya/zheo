import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGstCsv,
  csvEscape,
  gstMonthWindow,
  gstinForRestaurant,
  parseGstMonth,
  round2,
  GST_CSV_HEADER,
} from "./gstExport";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";
import type { RestaurantDTO } from "../repositories/catalogRepository";
import { AppError } from "../middleware/envelope";
import { sharedOrderRepo } from "../repositories/shared";

// ============================================
// GST Export (V12) unit tests
// GST_EXPORT_TRUTH_A2: fail-closed statutory identity, stable non-statutory
// order reference, frozen eligibility/amount/period semantics.
// ============================================

const REST: RestaurantDTO = {
  id: "a0000000-0000-4000-8000-000000000001",
  owner_id: "e0000000-0000-4000-a000-000000000001",
  name: "Biryani House",
  gst_number: "27AABCB1234A1Z5",
  commission_rate: 0.08,
  is_active: true,
  lat: 19.076,
  lng: 72.8777,
  pickup_eta_min: 25,
  rating: 4.5,
  cuisines: ["North Indian", "Biryani"],
  price_for_one: 300,
  cover_image: "https://picsum.photos/seed/biryani-house/600/450",
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
    gift_id: null,
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

function expectGstinRejected(gstNumber: string | null): void {
  try {
    gstinForRestaurant({ id: REST.id, gst_number: gstNumber });
    throw new Error("expected gstinForRestaurant to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("GST_NUMBER_REQUIRED");
    expect((err as AppError).status).toBeGreaterThanOrEqual(400);
  }
}

describe("GST export helpers", () => {
  it("parseGstMonth accepts YYYY-MM and rejects anything else", () => {
    expect(parseGstMonth("2026-08")).toBe("2026-08");
    expect(() => parseGstMonth("2026-13")).toThrow(AppError);
    expect(() => parseGstMonth("2026-8")).toThrow(AppError);
    expect(() => parseGstMonth("Aug 2026")).toThrow(AppError);
    expect(() => parseGstMonth(undefined)).toThrow(AppError);
  });

  it("gstMonthWindow spans the exact calendar month (unchanged)", () => {
    const { startIso, endIso } = gstMonthWindow("2026-08");
    expect(startIso).toBe("2026-08-01T00:00:00.000Z");
    expect(endIso).toBe("2026-09-01T00:00:00.000Z");
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

  // ---- TRACK-A / GSTIN authority (G1-G6) ----------------------------------

  it("G1: gstinForRestaurant returns the real persisted GSTIN exactly", () => {
    expect(gstinForRestaurant(REST)).toBe("27AABCB1234A1Z5");
    expect(
      gstinForRestaurant({
        id: REST.id,
        gst_number: "29ZZZZZ9999Z9Z9",
      }),
    ).toBe("29ZZZZZ9999Z9Z9");
  });

  it("G2: gstinForRestaurant fails closed when the GSTIN is missing", () => {
    expectGstinRejected(null);
  });

  it("G3: gstinForRestaurant fails closed when the GSTIN is blank", () => {
    expectGstinRejected("");
  });

  it("G4: gstinForRestaurant fails closed when the GSTIN is whitespace-only", () => {
    expectGstinRejected("   ");
  });

  it("G5: never fabricates a synthetic 27MOCK GSTIN", () => {
    expect(() =>
      gstinForRestaurant({ id: REST.id, gst_number: null }),
    ).toThrow(AppError);
    const csv = buildGstCsv(
      [makeOrder("o1", "2026-08-04T10:00:00.000Z", 200)],
      REST,
    );
    expect(csv).not.toContain("27MOCK");
  });

  it("G6: missing GSTIN no longer falls back to a deterministic mock value", () => {
    // Previously this returned a deterministic 27MOCK... value. That fallback
    // is removed: an absent GSTIN now rejects instead of inventing identity.
    expect(() =>
      gstinForRestaurant({ id: REST.id, gst_number: null }),
    ).toThrow(AppError);
  });
});

describe("buildGstCsv", () => {
  it("emits the non-statutory header and one row per order", () => {
    const orders = [
      makeOrder("o1", "2026-08-04T10:00:00.000Z", 200),
      makeOrder("o2", "2026-08-05T11:00:00.000Z", 440),
    ];

    const csv = buildGstCsv(orders, REST);
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe(GST_CSV_HEADER);
    expect(lines[0]).toBe(
      "Order Reference,GSTIN,Date,Taxable Value,CGST 2.5%,SGST 2.5%",
    );
    expect(lines).toHaveLength(3);

    // Row 1: taxable 200 -> CGST/SGST 5 each
    expect(lines[1]).toBe(
      "o1,27AABCB1234A1Z5,2026-08-04,200.00,5.00,5.00",
    );
    // Row 2: taxable 440 -> CGST/SGST 11 each
    expect(lines[2]).toBe(
      "o2,27AABCB1234A1Z5,2026-08-05,440.00,11.00,11.00",
    );
  });

  it("T11: amount columns are unchanged by A2", () => {
    const csv = buildGstCsv(
      [
        makeOrder("o1", "2026-08-04T10:00:00.000Z", 220),
        makeOrder("o2", "2026-08-05T11:00:00.000Z", 440),
      ],
      REST,
    );
    // 220 * 0.025 = 5.50; 440 * 0.025 = 11.00
    expect(csv).toContain(",220.00,5.50,5.50");
    expect(csv).toContain(",440.00,11.00,11.00");
  });

  it("returns just the header when there are no orders", () => {
    const csv = buildGstCsv([], REST);
    expect(csv).toBe(GST_CSV_HEADER);
  });
});

describe("stable non-statutory order reference", () => {
  const o1 = makeOrder("o1", "2026-08-04T10:00:00.000Z", 200);
  const o2 = makeOrder("o2", "2026-08-05T11:00:00.000Z", 440);

  function lineFor(csv: string, id: string): string {
    const line = csv.split("\r\n").find((l) => l.startsWith(`${id},`));
    if (!line) throw new Error(`no CSV line for ${id}`);
    return line;
  }

  it("I1: the same order yields the same reference on repeated exports", () => {
    const a = lineFor(buildGstCsv([o1], REST), "o1");
    const b = lineFor(buildGstCsv([o1], REST), "o1");
    expect(a).toBe(b);
  });

  it("I2: a narrower export window does not change the reference", () => {
    const wide = buildGstCsv([o1, o2], REST);
    const narrow = buildGstCsv([o1], REST);
    expect(lineFor(narrow, "o1")).toBe(lineFor(wide, "o1"));
  });

  it("I3: adding another qualifying order does not renumber existing ones", () => {
    const before = lineFor(buildGstCsv([o1], REST), "o1");
    const after = lineFor(buildGstCsv([o1, o2], REST), "o1");
    expect(after).toBe(before);
  });

  it("I4: sort order cannot renumber an existing row", () => {
    const forward = buildGstCsv([o1, o2], REST);
    const reversed = buildGstCsv([o2, o1], REST);
    expect(lineFor(reversed, "o1")).toBe(lineFor(forward, "o1"));
    expect(lineFor(reversed, "o2")).toBe(lineFor(forward, "o2"));
  });

  it("I5: the reference equals the stable persisted order id", () => {
    const csv = buildGstCsv([o1], REST);
    expect(csv.split("\r\n")[1]!.split(",")[0]).toBe("o1");
  });

  it("I6: no generated INV-<month>-sequence identity remains", () => {
    const csv = buildGstCsv([o1, o2], REST);
    expect(csv).not.toMatch(/INV-\d{4}-\d{2}-\d{4}/);
    expect(csv).not.toContain("INV-");
    expect(csv).not.toContain("Invoice");
  });
});

describe("GST export eligibility source (frozen contract)", () => {
  beforeEach(() => {
    sharedOrderRepo._reset();
  });

  const REST_ID = REST.id;
  const OTHER_ID = "a0000000-0000-4000-8000-000000000002";
  const FROM = "2026-08-01T00:00:00.000Z";
  const TO = "2026-09-01T00:00:00.000Z";

  function seed(
    id: string,
    createdAt: string,
    status: OrderDTO["status"],
    restaurantId = REST_ID,
  ): void {
    sharedOrderRepo._seed({
      ...makeOrder(id, createdAt, 200, status),
      restaurant_id: restaurantId,
    });
  }

  it("E1/E2: PICKED_UP and SETTLED remain eligible", async () => {
    seed("o-picked", "2026-08-04T10:00:00.000Z", "PICKED_UP");
    seed("o-settled", "2026-08-05T11:00:00.000Z", "SETTLED");

    const orders = await sharedOrderRepo.getSettlableOrdersByRestaurant(
      REST_ID,
      FROM,
      TO,
    );
    expect(orders.map((o) => o.id).sort()).toEqual(["o-picked", "o-settled"]);
  });

  it("E3: non-eligible statuses are excluded", async () => {
    seed("o-confirmed", "2026-08-04T10:00:00.000Z", "CONFIRMED");
    seed("o-preparing", "2026-08-05T11:00:00.000Z", "PREPARING");
    seed("o-cancelled", "2026-08-06T11:00:00.000Z", "CANCELLED");
    seed("o-picked", "2026-08-07T11:00:00.000Z", "PICKED_UP");

    const orders = await sharedOrderRepo.getSettlableOrdersByRestaurant(
      REST_ID,
      FROM,
      TO,
    );
    expect(orders.map((o) => o.id)).toEqual(["o-picked"]);
  });

  it("E4: the period filter stays creation-time based [from, to)", async () => {
    seed("o-before", "2026-07-31T23:59:59.000Z", "PICKED_UP");
    seed("o-start", "2026-08-01T00:00:00.000Z", "PICKED_UP");
    seed("o-end-exclusive", "2026-09-01T00:00:00.000Z", "PICKED_UP");
    seed("o-other-restaurant", "2026-08-15T00:00:00.000Z", "PICKED_UP", OTHER_ID);

    const orders = await sharedOrderRepo.getSettlableOrdersByRestaurant(
      REST_ID,
      FROM,
      TO,
    );
    expect(orders.map((o) => o.id)).toEqual(["o-start"]);
  });
});
