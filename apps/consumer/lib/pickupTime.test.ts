import { describe, expect, it } from "vitest";
import { istDateString } from "./pickupTime";

describe("istDateString", () => {
  it("returns the UTC date when the UTC and IST dates agree", () => {
    expect(istDateString(new Date("2026-08-24T10:00:00.000Z"))).toBe("2026-08-24");
  });

  it("returns the pre-midnight IST date just before the UTC day rolls over", () => {
    // 2026-08-24T18:29:00Z = 2026-08-24 23:59 IST
    expect(istDateString(new Date("2026-08-24T18:29:00.000Z"))).toBe("2026-08-24");
  });

  it("advances to the next IST day at the UTC day boundary", () => {
    // 2026-08-24T18:30:00Z = 2026-08-25 00:00 IST
    expect(istDateString(new Date("2026-08-24T18:30:00.000Z"))).toBe("2026-08-25");
    // 2026-08-24T19:00:00Z = 2026-08-25 00:30 IST
    expect(istDateString(new Date("2026-08-24T19:00:00.000Z"))).toBe("2026-08-25");
  });

  it("never depends on the host process timezone", () => {
    const instant = new Date("2026-08-24T20:00:00.000Z");
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const la = istDateString(instant);
      process.env.TZ = "Asia/Kolkata";
      const kolkata = istDateString(instant);
      expect(la).toBe(kolkata);
      expect(la).toBe("2026-08-25");
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
