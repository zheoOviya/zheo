import { describe, expect, it } from "vitest";
import {
  dineInActionLabel,
  dineInMutationMessage,
  dineInStatusMeta,
  isDineInCancellable,
  nextDineInTarget,
} from "../dineIn";
import type { DineInOrderStatus } from "../api";

const STATUSES: DineInOrderStatus[] = [
  "PLACED",
  "PREPARING",
  "READY_TO_SERVE",
  "SERVED",
  "CANCELLED",
];

describe("dineInStatusMeta", () => {
  it("labels every dine-in status truthfully", () => {
    expect(dineInStatusMeta("PLACED").label).toBe("Placed");
    expect(dineInStatusMeta("PREPARING").label).toBe("Preparing");
    expect(dineInStatusMeta("READY_TO_SERVE").label).toBe("Ready to Serve");
    expect(dineInStatusMeta("SERVED").label).toBe("Served");
    expect(dineInStatusMeta("CANCELLED").label).toBe("Cancelled");
  });

  it("always returns a badge and dot class for every status", () => {
    for (const status of STATUSES) {
      const meta = dineInStatusMeta(status);
      expect(meta.badge.length).toBeGreaterThan(0);
      expect(meta.dot.length).toBeGreaterThan(0);
    }
  });
});

describe("nextDineInTarget", () => {
  it("returns the exact legal forward edge per status", () => {
    expect(nextDineInTarget("PLACED")).toBe("PREPARING");
    expect(nextDineInTarget("PREPARING")).toBe("READY_TO_SERVE");
    expect(nextDineInTarget("READY_TO_SERVE")).toBe("SERVED");
  });

  it("returns null for terminal statuses", () => {
    expect(nextDineInTarget("SERVED")).toBeNull();
    expect(nextDineInTarget("CANCELLED")).toBeNull();
  });
});

describe("dineInActionLabel", () => {
  it("labels the action for each advanceable status", () => {
    expect(dineInActionLabel("PLACED")).toBe("Start Preparing");
    expect(dineInActionLabel("PREPARING")).toBe("Mark Ready to Serve");
    expect(dineInActionLabel("READY_TO_SERVE")).toBe("Mark Served");
  });

  it("has no advance action for terminal statuses", () => {
    expect(dineInActionLabel("SERVED")).toBeNull();
    expect(dineInActionLabel("CANCELLED")).toBeNull();
  });
});

describe("isDineInCancellable", () => {
  it("allows cancellation only for PLACED and PREPARING", () => {
    expect(isDineInCancellable("PLACED")).toBe(true);
    expect(isDineInCancellable("PREPARING")).toBe(true);
    expect(isDineInCancellable("READY_TO_SERVE")).toBe(false);
    expect(isDineInCancellable("SERVED")).toBe(false);
    expect(isDineInCancellable("CANCELLED")).toBe(false);
  });
});

describe("dineInMutationMessage", () => {
  it("maps an invalid transition to a refresh hint", () => {
    expect(dineInMutationMessage("INVALID_DINE_IN_TRANSITION")).toContain(
      "already updated elsewhere",
    );
  });

  it("maps a missing order to a removal hint", () => {
    expect(dineInMutationMessage("ORDER_NOT_FOUND")).toContain("no longer exists");
  });

  it("preserves the server fallback for unknown codes", () => {
    expect(dineInMutationMessage("SOMETHING_ELSE", "Server said no")).toBe("Server said no");
    expect(dineInMutationMessage(undefined, "Server said no")).toBe("Server said no");
  });

  it("returns a generic message when nothing is available", () => {
    expect(dineInMutationMessage(undefined)).toContain("Could not update");
  });
});
