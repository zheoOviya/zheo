import { describe, expect, it } from "vitest";
import {
  RENDERABLE_SERVICE_REQUEST_TYPES,
  SERVICE_REQUEST_ACTIVE_STATUSES,
  isBringBillRequest,
  isRenderableServiceRequest,
  serviceRequestAction,
  serviceRequestActionLabel,
  serviceRequestBusyLabel,
  serviceRequestMutationMessage,
  serviceRequestStatusMeta,
  serviceRequestTypeLabel,
} from "../serviceRequests";
import type { ServiceRequestStatus, ServiceRequestType } from "../api";

const STATUSES: ServiceRequestStatus[] = ["PENDING", "ACKNOWLEDGED", "COMPLETED", "CANCELLED"];

const TYPES: ServiceRequestType[] = [
  "WATER",
  "EXTRA_PLATE",
  "CUTLERY",
  "TISSUE",
  "CLEAN_TABLE",
  "CALL_STAFF",
  "BRING_BILL",
  "OTHER",
];

describe("serviceRequestStatusMeta", () => {
  it("labels every service-request status truthfully", () => {
    expect(serviceRequestStatusMeta("PENDING").label).toBe("Pending");
    expect(serviceRequestStatusMeta("ACKNOWLEDGED").label).toBe("Acknowledged");
    expect(serviceRequestStatusMeta("COMPLETED").label).toBe("Completed");
    expect(serviceRequestStatusMeta("CANCELLED").label).toBe("Cancelled");
  });

  it("always returns a badge and dot class for every status", () => {
    for (const status of STATUSES) {
      const meta = serviceRequestStatusMeta(status);
      expect(meta.badge.length).toBeGreaterThan(0);
      expect(meta.dot.length).toBeGreaterThan(0);
    }
  });
});

describe("serviceRequestTypeLabel", () => {
  it("labels every request type (incl. the defensive BRING_BILL entry)", () => {
    expect(serviceRequestTypeLabel("WATER")).toBe("Water");
    expect(serviceRequestTypeLabel("EXTRA_PLATE")).toBe("Extra plate");
    expect(serviceRequestTypeLabel("CUTLERY")).toBe("Cutlery");
    expect(serviceRequestTypeLabel("TISSUE")).toBe("Tissue");
    expect(serviceRequestTypeLabel("CLEAN_TABLE")).toBe("Clean table");
    expect(serviceRequestTypeLabel("CALL_STAFF")).toBe("Call staff");
    expect(serviceRequestTypeLabel("BRING_BILL")).toBe("Bring bill");
    expect(serviceRequestTypeLabel("OTHER")).toBe("Other");
  });

  it("renders only the customer-creatable types (BRING_BILL absent)", () => {
    expect(RENDERABLE_SERVICE_REQUEST_TYPES).toEqual([
      "WATER",
      "EXTRA_PLATE",
      "CUTLERY",
      "TISSUE",
      "CLEAN_TABLE",
      "CALL_STAFF",
      "OTHER",
    ]);
    expect(RENDERABLE_SERVICE_REQUEST_TYPES).not.toContain("BRING_BILL");
    for (const type of RENDERABLE_SERVICE_REQUEST_TYPES) {
      expect(serviceRequestTypeLabel(type).length).toBeGreaterThan(0);
    }
  });
});

describe("serviceRequestAction", () => {
  it("acknowledges only PENDING", () => {
    expect(serviceRequestAction("PENDING")).toBe("acknowledge");
  });

  it("completes only ACKNOWLEDGED (never silently completes PENDING)", () => {
    expect(serviceRequestAction("ACKNOWLEDGED")).toBe("complete");
  });

  it("has no action for terminal statuses", () => {
    expect(serviceRequestAction("COMPLETED")).toBeNull();
    expect(serviceRequestAction("CANCELLED")).toBeNull();
  });
});

describe("serviceRequestActionLabel / busy label", () => {
  it("labels the action and its busy state", () => {
    expect(serviceRequestActionLabel("acknowledge")).toBe("Acknowledge");
    expect(serviceRequestActionLabel("complete")).toBe("Mark Complete");
    expect(serviceRequestActionLabel(null)).toBeNull();
    expect(serviceRequestBusyLabel("acknowledge")).toBe("Acknowledging...");
    expect(serviceRequestBusyLabel("complete")).toBe("Completing...");
  });
});

describe("isBringBillRequest", () => {
  it("flags only BRING_BILL", () => {
    for (const type of TYPES) {
      expect(isBringBillRequest(type)).toBe(type === "BRING_BILL");
    }
  });
});

describe("isRenderableServiceRequest", () => {
  it("accepts actionable, non-BRING_BILL rows", () => {
    expect(isRenderableServiceRequest({ request_type: "WATER", status: "PENDING" })).toBe(true);
    expect(isRenderableServiceRequest({ request_type: "CUTLERY", status: "ACKNOWLEDGED" })).toBe(
      true,
    );
  });

  it("rejects BRING_BILL regardless of status", () => {
    expect(isRenderableServiceRequest({ request_type: "BRING_BILL", status: "PENDING" })).toBe(
      false,
    );
  });

  it("rejects terminal statuses", () => {
    expect(isRenderableServiceRequest({ request_type: "WATER", status: "COMPLETED" })).toBe(false);
    expect(isRenderableServiceRequest({ request_type: "WATER", status: "CANCELLED" })).toBe(false);
  });

  it("active status list is exactly the queue membership", () => {
    expect(SERVICE_REQUEST_ACTIVE_STATUSES).toEqual(["PENDING", "ACKNOWLEDGED"]);
  });
});

describe("serviceRequestMutationMessage", () => {
  it("maps a stale/conflicting transition to a refresh hint", () => {
    expect(serviceRequestMutationMessage("INVALID_SERVICE_REQUEST_TRANSITION")).toContain(
      "already updated elsewhere",
    );
  });

  it("maps a missing request to a refresh hint", () => {
    expect(serviceRequestMutationMessage("SERVICE_REQUEST_NOT_FOUND")).toContain(
      "no longer exists",
    );
  });

  it("maps the defensive BRING_BILL boundary to the billing-flow copy", () => {
    expect(serviceRequestMutationMessage("BRING_BILL_MANAGED_BY_BILL_FLOW")).toContain(
      "billing flow",
    );
  });

  it("preserves the server fallback for unknown codes", () => {
    expect(serviceRequestMutationMessage("SOMETHING_ELSE", "Server said no")).toBe(
      "Server said no",
    );
    expect(serviceRequestMutationMessage(undefined, "Server said no")).toBe("Server said no");
  });

  it("returns a generic message when nothing is available", () => {
    expect(serviceRequestMutationMessage(undefined)).toContain("Could not update");
  });
});
