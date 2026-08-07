export interface HeatmapCell {
  lat: number;
  lng: number;
  count: number;
}

export interface HeatmapResult {
  window_minutes: number;
  total_orders: number;
  generated_at: string;
  cells: HeatmapCell[];
}

// Browser fetches use relative /api/* URLs (routed through the Next.js
// rewrite to the API server). Server-side fetches (RSC) need an absolute
// origin, so fall back to the local API server when no env override is set.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window === "undefined" ? "http://localhost:3001" : "");

async function fetcher<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    cache: "no-store",
  });
  const body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string } | null;
  } = await res.json();
  if (!body.success || body.data === null) {
    throw new Error(body.error?.message ?? "Request failed");
  }
  return body.data;
}

export function fetchHeatmap(): Promise<HeatmapResult> {
  return fetcher<HeatmapResult>("/api/v1/discovery/heatmap");
}
