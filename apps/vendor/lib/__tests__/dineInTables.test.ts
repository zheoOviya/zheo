import { describe, expect, it } from "vitest";
import {
  DISABLED_TABLE_META,
  FREE_TABLE_STATUS_META,
  deriveBoardSummary,
  isTableFree,
  shortSessionId,
  tableSessionStatusMeta,
} from "../dineInTables";
import type { DineInTableSessionStatus, VendorTableBoardRow } from "../api";

const SESSION_STATUSES: DineInTableSessionStatus[] = [
  "OPEN",
  "ACTIVE",
  "BILL_REQUESTED",
  "PAYMENT_PENDING",
];

function liveSession(
  status: DineInTableSessionStatus,
  overrides: Partial<NonNullable<VendorTableBoardRow["session"]>> = {},
): NonNullable<VendorTableBoardRow["session"]> {
  return {
    id: "sess-0000-0000-1234abcd",
    status,
    opened_at: "2026-09-04T05:00:00.000Z",
    bill_requested_at: null,
    ...overrides,
  };
}

function tableRow(
  opts: {
    table?: Partial<VendorTableBoardRow["table"]>;
    zone?: VendorTableBoardRow["zone"];
    session?: VendorTableBoardRow["session"];
    open_order_count?: number;
    open_request_count?: number;
  } = {},
): VendorTableBoardRow {
  return {
    table: { id: "t1", label: "T1", seat_count: 4, is_active: true, ...opts.table },
    zone: opts.zone === undefined ? { id: "z1", name: "Patio" } : opts.zone,
    session: opts.session === undefined ? null : opts.session,
    open_order_count: opts.open_order_count ?? 0,
    open_request_count: opts.open_request_count ?? 0,
  };
}

describe("tableSessionStatusMeta", () => {
  it("labels every live-session status truthfully", () => {
    expect(tableSessionStatusMeta("OPEN").label).toBe("Open");
    expect(tableSessionStatusMeta("ACTIVE").label).toBe("Active");
    expect(tableSessionStatusMeta("BILL_REQUESTED").label).toBe("Bill requested");
    expect(tableSessionStatusMeta("PAYMENT_PENDING").label).toBe("Payment pending");
  });

  it("pins the frozen C1 palette: sky / teal / amber / violet", () => {
    expect(tableSessionStatusMeta("OPEN").badge).toBe("bg-sky-50 text-sky-700 ring-sky-200");
    expect(tableSessionStatusMeta("ACTIVE").badge).toBe("bg-teal-50 text-teal-700 ring-teal-200");
    expect(tableSessionStatusMeta("BILL_REQUESTED").badge).toBe(
      "bg-amber-50 text-amber-700 ring-amber-200",
    );
    expect(tableSessionStatusMeta("PAYMENT_PENDING").badge).toBe(
      "bg-violet-50 text-violet-700 ring-violet-200",
    );
  });

  it("always returns a badge and dot class for every status", () => {
    for (const status of SESSION_STATUSES) {
      const meta = tableSessionStatusMeta(status);
      expect(meta.badge.length).toBeGreaterThan(0);
      expect(meta.dot.length).toBeGreaterThan(0);
    }
  });
});

describe("free / disabled meta", () => {
  it("Free is a distinct neutral chip next to the session map", () => {
    expect(FREE_TABLE_STATUS_META.label).toBe("Free");
    expect(FREE_TABLE_STATUS_META.badge.length).toBeGreaterThan(0);
    expect(FREE_TABLE_STATUS_META.dot.length).toBeGreaterThan(0);
  });

  it("Disabled is an independent pill that never reuses occupancy copy", () => {
    expect(DISABLED_TABLE_META.label).toBe("Disabled");
    expect(DISABLED_TABLE_META.badge.length).toBeGreaterThan(0);
    expect(DISABLED_TABLE_META.label).not.toBe(tableSessionStatusMeta("OPEN").label);
    expect(DISABLED_TABLE_META.label).not.toBe(FREE_TABLE_STATUS_META.label);
  });
});

describe("isTableFree", () => {
  it("a table is Free exactly when it has no live session", () => {
    expect(isTableFree(tableRow())).toBe(true);
    expect(isTableFree(tableRow({ session: liveSession("ACTIVE") }))).toBe(false);
  });

  it("is_active never affects occupancy: a disabled table with a live session is not Free", () => {
    expect(
      isTableFree(tableRow({ table: { is_active: false }, session: liveSession("OPEN") })),
    ).toBe(false);
    expect(isTableFree(tableRow({ table: { is_active: false } }))).toBe(true);
  });
});

describe("deriveBoardSummary", () => {
  it("empty board summarizes to zeros", () => {
    expect(deriveBoardSummary([])).toEqual({
      total: 0,
      occupied: 0,
      free: 0,
      openRequests: 0,
    });
  });

  it("counts occupied/free from live sessions and sums open requests", () => {
    const rows = [
      tableRow({ session: liveSession("ACTIVE"), open_order_count: 1, open_request_count: 2 }),
      tableRow({ session: liveSession("PAYMENT_PENDING"), open_request_count: 1 }),
      tableRow(),
      tableRow({ table: { is_active: false } }),
    ];
    expect(deriveBoardSummary(rows)).toEqual({
      total: 4,
      occupied: 2,
      free: 2,
      openRequests: 3,
    });
  });

  it("keeps total = occupied + free even when disabled tables carry sessions", () => {
    const rows = [
      tableRow({ table: { is_active: false }, session: liveSession("ACTIVE") }),
      tableRow({ session: liveSession("OPEN") }),
      tableRow(),
    ];
    const summary = deriveBoardSummary(rows);
    expect(summary.total).toBe(3);
    expect(summary.occupied).toBe(2);
    expect(summary.free).toBe(1);
    expect(summary.occupied + summary.free).toBe(summary.total);
  });
});

describe("shortSessionId", () => {
  it("shows the last four chars uppercased for guest verification", () => {
    expect(shortSessionId("sess-0000-0000-1234abcd")).toBe("ABCD");
    expect(shortSessionId("abc")).toBe("ABC");
  });
});
