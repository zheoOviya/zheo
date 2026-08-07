import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EtaService, haversineKm, istTrafficFactor } from "./etaService";

// ============================================
// P04 Traffic-based ETA unit tests
// ============================================

const ORIGIN = { lat: 19.076, lng: 72.8777 }; // Biryani House (Fort, Mumbai)
const DEST = { lat: 19.1136, lng: 72.8697 }; // Green Bowl (Dadar, Mumbai)

describe("haversineKm", () => {
  it("returns 0 for identical coordinates", () => {
    expect(haversineKm(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
  });

  it("computes a sane Mumbai distance (~4.5 km Fort -> Dadar)", () => {
    const km = haversineKm(ORIGIN.lat, ORIGIN.lng, DEST.lat, DEST.lng);
    expect(km).toBeGreaterThan(3);
    expect(km).toBeLessThan(6);
  });
});

describe("istTrafficFactor", () => {
  it("returns 1.4 during IST rush hours", () => {
    // 09:00 UTC = 14:30 IST -> not rush. Use 03:30 UTC = 09:00 IST (morning rush).
    expect(istTrafficFactor(new Date("2026-08-05T03:30:00Z"))).toBe(1.4);
    // 12:30 UTC = 18:00 IST (evening rush).
    expect(istTrafficFactor(new Date("2026-08-05T12:30:00Z"))).toBe(1.4);
  });

  it("returns 1.0 outside rush hours", () => {
    // 01:00 UTC = 06:30 IST (off-peak).
    expect(istTrafficFactor(new Date("2026-08-05T01:00:00Z"))).toBe(1.0);
    // 15:00 UTC = 20:30 IST (after evening rush).
    expect(istTrafficFactor(new Date("2026-08-05T15:00:00Z"))).toBe(1.0);
  });
});

describe("EtaService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mock mode (no API key)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("returns a mock ETA proportional to distance, source=mock", async () => {
      vi.setSystemTime(new Date("2026-08-05T01:00:00Z")); // off-peak IST
      const service = new EtaService("", "http://unused");
      const eta = await service.getTrafficETA(
        ORIGIN.lat,
        ORIGIN.lng,
        DEST.lat,
        DEST.lng,
      );

      expect(eta.source).toBe("mock");
      expect(eta.distance_km).toBeGreaterThan(3);
      expect(eta.distance_km).toBeLessThan(6);
      expect(eta.eta_seconds).toBeGreaterThan(0);
      expect(eta.duration_text).toMatch(/^\d+ mins$/);
    });

    it("is slower during IST rush hour (traffic multiplier applied)", async () => {
      const service = new EtaService("", "http://unused");

      vi.setSystemTime(new Date("2026-08-05T01:00:00Z")); // off-peak
      const offPeak = await service.getTrafficETA(
        ORIGIN.lat,
        ORIGIN.lng,
        DEST.lat,
        DEST.lng,
      );

      vi.setSystemTime(new Date("2026-08-05T03:30:00Z")); // 09:00 IST rush
      const rush = await service.getTrafficETA(
        ORIGIN.lat,
        ORIGIN.lng,
        DEST.lat,
        DEST.lng,
      );

      expect(rush.eta_seconds).toBeGreaterThan(offPeak.eta_seconds);
    });
  });

  describe("google mode (API key set)", () => {
    it("parses duration_in_traffic from the Distance Matrix response", async () => {
      const fakeFetch = vi.fn(async (_url: string) => ({
        ok: true,
        json: async () => ({
          status: "OK",
          rows: [
            {
              elements: [
                {
                  status: "OK",
                  duration_in_traffic: { value: 780, text: "13 mins" },
                  duration: { value: 900, text: "15 mins" },
                  distance: { value: 5000, text: "5.0 km" },
                },
              ],
            },
          ],
        }),
      }));

      const service = new EtaService("AIza-test-key", "https://maps.example/distancematrix/json", fakeFetch as unknown as typeof fetch);
      const eta = await service.getTrafficETA(
        ORIGIN.lat,
        ORIGIN.lng,
        DEST.lat,
        DEST.lng,
      );

      expect(eta.source).toBe("google");
      expect(eta.eta_seconds).toBe(780);
      expect(eta.duration_text).toBe("13 mins");
      expect(eta.distance_km).toBe(5);

      const url = fakeFetch.mock.calls[0]![0] as string;
      expect(url).toContain("origins=19.076%2C72.8777");
      expect(url).toContain("departure_time=now");
      expect(url).toContain("traffic_model=best_guess");
      expect(url).toContain("key=AIza-test-key");
    });

    it("falls back to mock when the API errors", async () => {
      const fakeFetch = vi.fn(async (_url: string) => {
        throw new Error("network down");
      });
      const service = new EtaService("AIza-test-key", "https://maps.example/distancematrix/json", fakeFetch as unknown as typeof fetch);
      const eta = await service.getTrafficETA(
        ORIGIN.lat,
        ORIGIN.lng,
        DEST.lat,
        DEST.lng,
      );
      expect(eta.source).toBe("mock");
    });
  });
});
