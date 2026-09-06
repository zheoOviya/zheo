import { describe, expect, it } from "vitest";
import type { VendorBillDetail, VendorBillTotalsDTO } from "@/lib/api";
import {
  billAction,
  billActionLabel,
  billBusyLabel,
  billDetailStatusMeta,
  billGstTotal,
  billMutationMessage,
  billQueueStatusMeta,
  hasPackagingFee,
  isDeliveredBill,
} from "@/lib/dineInBills";

const REST_ID = "a0000000-0000-4000-8000-000000000001";

function billTotals(overrides: Partial<VendorBillTotalsDTO> = {}): VendorBillTotalsDTO {
  return {
    id: "bill-0000-0000-0000-000000000001",
    session_id: "session-0000-0000-0000-000000000001",
    restaurant_id: REST_ID,
    food_subtotal: 200,
    packaging_fee: 0,
    gst_food: 18,
    gst_packaging: 0,
    total_amount: 236,
    frozen_at: "2026-09-04T05:31:00.000Z",
    ...overrides,
  };
}

function billDetail(
  overrides: Partial<VendorBillDetail> = {},
): VendorBillDetail {
  return {
    bill: billTotals(),
    session: {
      id: "session-0000-0000-0000-000000000001",
      status: "BILL_REQUESTED",
      bill_requested_at: "2026-09-04T05:30:00.000Z",
      opened_at: "2026-09-04T05:00:00.000Z",
    },
    table: { id: "table-0000-0000-0000-000000000001", label: "T1" },
    zone: { id: "zone-0000-0000-0000-000000000001", name: "Patio" },
    bring_bill_request: {
      id: "req-0000-0000-0000-000000000001",
      status: "PENDING",
      acknowledged_at: null,
      completed_at: null,
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

describe("billAction / labels", () => {
  it("derives the only legal action per queue status", () => {
    expect(billAction("PENDING")).toBe("acknowledge");
    expect(billAction("ACKNOWLEDGED")).toBe("deliver");
  });

  it("never skips PENDING straight to delivery and has no cancel action", () => {
    expect(billAction("PENDING")).not.toBe("deliver");
    expect(billAction("PENDING")).not.toBe("cancel");
    expect(billAction("ACKNOWLEDGED")).not.toBe("cancel");
  });

  it("renders the action button copy", () => {
    expect(billActionLabel("acknowledge")).toBe("Acknowledge");
    expect(billActionLabel("deliver")).toBe("Mark delivered");
    expect(billActionLabel(null)).toBeNull();
  });

  it("renders in-flight busy copy distinct from idle copy", () => {
    expect(billBusyLabel("acknowledge")).toBe("Acknowledging...");
    expect(billBusyLabel("deliver")).toBe("Delivering...");
  });
});

describe("status meta", () => {
  it("shares the board vocabulary for queue statuses", () => {
    expect(billQueueStatusMeta("PENDING").label).toBe("Pending");
    expect(billQueueStatusMeta("ACKNOWLEDGED").label).toBe("Acknowledged");
  });

  it("words a COMPLETED bill as Delivered (never as a generic completed task)", () => {
    expect(billDetailStatusMeta("COMPLETED").label).toBe("Delivered");
    expect(billDetailStatusMeta("COMPLETED").label).not.toBe("Completed");
  });

  it("keeps PENDING/ACKNOWLEDGED wording stable on the detail surface", () => {
    expect(billDetailStatusMeta("PENDING").label).toBe("Pending");
    expect(billDetailStatusMeta("ACKNOWLEDGED").label).toBe("Acknowledged");
  });
});

describe("billMutationMessage", () => {
  it("maps a stale transition to refresh copy", () => {
    expect(billMutationMessage("INVALID_SERVICE_REQUEST_TRANSITION")).toBe(
      "This bill was already handled elsewhere. The queue will refresh.",
    );
  });

  it("maps a vanished bill to refresh copy", () => {
    expect(billMutationMessage("BILL_NOT_FOUND")).toBe(
      "This bill is no longer available. The queue will refresh.",
    );
  });

  it("falls back to the raw message for unexpected codes", () => {
    expect(billMutationMessage("SOMETHING_ELSE", "server exploded")).toBe("server exploded");
    expect(billMutationMessage(undefined, "server exploded")).toBe("server exploded");
    expect(billMutationMessage("SOMETHING_ELSE")).toBe(
      "Could not update this bill. Please try again.",
    );
  });
});

describe("delivered detection", () => {
  it("treats a bill as delivered only at COMPLETED", () => {
    expect(
      isDeliveredBill(
        billDetail({
          bring_bill_request: { ...billDetail().bring_bill_request!, status: "COMPLETED" },
        }),
      ),
    ).toBe(true);
    expect(isDeliveredBill(billDetail())).toBe(false);
    expect(
      isDeliveredBill(
        billDetail({
          bring_bill_request: { ...billDetail().bring_bill_request!, status: "ACKNOWLEDGED" },
        }),
      ),
    ).toBe(false);
    expect(isDeliveredBill(billDetail({ bring_bill_request: null }))).toBe(false);
  });
});

describe("frozen money presentation helpers", () => {
  it("sums the already-frozen GST split without touching the total", () => {
    const bill = billTotals({ gst_food: 18, gst_packaging: 4, total_amount: 260 });
    expect(billGstTotal(bill)).toBe(22);
    // A bill with no packaging still carries its food GST.
    expect(billGstTotal(billTotals())).toBe(18);
  });

  it("reports a packaging line only when a positive fee was frozen", () => {
    expect(hasPackagingFee(billTotals())).toBe(false);
    expect(hasPackagingFee(billTotals({ packaging_fee: 0 }))).toBe(false);
    expect(hasPackagingFee(billTotals({ packaging_fee: 20 }))).toBe(true);
  });
});
