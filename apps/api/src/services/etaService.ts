import { config } from "../config";

// ============================================
// P04 Traffic-based ETA (pickup enhancements)
// getTrafficETA(origin_lat, origin_lng, destination_lat, destination_lng)
// Calls the Google Distance Matrix API when GOOGLE_MAPS_API_KEY is set;
// otherwise returns a traffic-aware mock so the demo is fully offline.
// ============================================

export interface TrafficEta {
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  eta_seconds: number;
  duration_text: string;
  distance_km: number;
  source: "google" | "mock";
}

export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** IST rush-hour multiplier: x1.4 during 08:00-11:00 and 17:00-20:00. */
export function istTrafficFactor(date: Date = new Date()): number {
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  const istHour = new Date(istMs).getUTCHours();
  if ((istHour >= 8 && istHour < 11) || (istHour >= 17 && istHour < 20)) {
    return 1.4;
  }
  return 1.0;
}

const MOCK_AVG_KMH = 25;

function mockEta(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  now: Date = new Date(),
): TrafficEta {
  const distanceKm = haversineKm(originLat, originLng, destLat, destLng);
  const speedKmh = MOCK_AVG_KMH / istTrafficFactor(now);
  const etaSeconds = Math.round((distanceKm / speedKmh) * 3600);
  const minutes = Math.max(1, Math.round(etaSeconds / 60));
  return {
    origin_lat: originLat,
    origin_lng: originLng,
    destination_lat: destLat,
    destination_lng: destLng,
    eta_seconds: etaSeconds,
    duration_text: `${minutes} mins`,
    distance_km: Math.round(distanceKm * 10) / 10,
    source: "mock",
  };
}

interface DistanceMatrixElement {
  duration?: { value: number; text: string };
  duration_in_traffic?: { value: number; text: string };
  distance?: { value: number; text: string };
  status: string;
}

interface DistanceMatrixResponse {
  status: string;
  rows?: Array<{ elements: DistanceMatrixElement[] }>;
}

export class EtaService {
  constructor(
    private readonly apiKey = config.googleMaps.apiKey,
    private readonly baseUrl = config.googleMaps.baseUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getTrafficETA(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number,
  ): Promise<TrafficEta> {
    if (!this.apiKey) {
      return mockEta(originLat, originLng, destinationLat, destinationLng);
    }
    try {
      return await this.googleEta(
        originLat,
        originLng,
        destinationLat,
        destinationLng,
      );
    } catch {
      return mockEta(originLat, originLng, destinationLat, destinationLng);
    }
  }

  private async googleEta(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number,
  ): Promise<TrafficEta> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("origins", `${originLat},${originLng}`);
    url.searchParams.set("destinations", `${destinationLat},${destinationLng}`);
    url.searchParams.set("departure_time", "now");
    url.searchParams.set("traffic_model", "best_guess");
    url.searchParams.set("units", "metric");
    url.searchParams.set("key", this.apiKey);

    const res = await this.fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`Distance Matrix API responded ${res.status}`);
    }
    const data = (await res.json()) as DistanceMatrixResponse;
    if (data.status !== "OK" || !data.rows?.[0]?.elements?.[0]) {
      throw new Error(`Distance Matrix API status ${data.status}`);
    }
    const element = data.rows[0].elements[0]!;
    if (element.status !== "OK") {
      throw new Error(`Distance Matrix element status ${element.status}`);
    }

    const duration = element.duration_in_traffic ?? element.duration;
    const etaSeconds = duration?.value ?? 0;
    const minutes = Math.max(1, Math.round(etaSeconds / 60));
    return {
      origin_lat: originLat,
      origin_lng: originLng,
      destination_lat: destinationLat,
      destination_lng: destinationLng,
      eta_seconds: etaSeconds,
      duration_text: `${minutes} mins`,
      distance_km: Math.round(((element.distance?.value ?? 0) / 1000) * 10) / 10,
      source: "google",
    };
  }
}

export const etaService = new EtaService();
