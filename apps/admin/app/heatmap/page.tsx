"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeatmapCell, HeatmapResult } from "../../lib/api";
import { fetchHeatmap } from "../../lib/api";

// D04 Hyperlocal Heatmap - ops view.
// Polls GET /api/v1/discovery/heatmap every 30s and renders order density as
// a teal dot-grid. Cell intensity = count / maxCellCount within the window.

// Mumbai bounding box for the ops grid (city-scale view).
const BOUNDS = {
  minLat: 18.9,
  maxLat: 19.3,
  minLng: 72.75,
  maxLng: 73.05,
};
const GRID_COLS = 24;
const GRID_ROWS = 24;

function normalize(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

interface GridPoint {
  col: number;
  row: number;
  count: number;
}

export default function HeatmapPage() {
  const [data, setData] = useState<HeatmapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [live, setLive] = useState(true);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await fetchHeatmap();
      setData(result);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load heatmap");
    }
  }, []);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      load();
    }
    if (!live) return undefined;
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load, live]);

  const points = useMemo<GridPoint[]>(() => {
    if (!data) return [];
    return data.cells.map((cell: HeatmapCell) => ({
      col: Math.min(
        GRID_COLS - 1,
        Math.floor(normalize(cell.lng, BOUNDS.minLng, BOUNDS.maxLng) * GRID_COLS),
      ),
      row: Math.min(
        GRID_ROWS - 1,
        Math.floor(
          (1 - normalize(cell.lat, BOUNDS.minLat, BOUNDS.maxLat)) * GRID_ROWS,
        ),
      ),
      count: cell.count,
    }));
  }, [data]);

  const maxCount = useMemo(
    () => Math.max(1, ...(data?.cells.map((c) => c.count) ?? [1])),
    [data],
  );

  const gridCells = useMemo(() => {
    const filled = new Map<string, number>();
    for (const p of points) filled.set(`${p.col},${p.row}`, p.count);
    const rows: { key: string; cols: (number | null)[] }[] = [];
    for (let row = 0; row < GRID_ROWS; row += 1) {
      const cols: (number | null)[] = [];
      for (let col = 0; col < GRID_COLS; col += 1) {
        cols.push(filled.get(`${col},${row}`) ?? null);
      }
      rows.push({ key: `row-${row}`, cols });
    }
    return rows;
  }, [points]);

  if (!data) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <div className="animate-skeleton-teal mb-6 h-10 w-64 rounded-lg bg-primary-200" />
        <div className="animate-skeleton-teal h-[540px] rounded-2xl bg-primary-200" />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary-700">
            SnakZap Ops Console
          </p>
          <h1 className="text-2xl font-bold text-neutral-900">
            Live Order Heatmap
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Aggregate order density for the last {data.window_minutes} minutes.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-primary-100 px-3 py-1 text-sm font-semibold text-primary-800">
            {data.total_orders} orders · {data.cells.length} hot zones
          </span>
          <button
            type="button"
            onClick={() => {
              setLive((v) => !v);
              load();
            }}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              live
                ? "bg-primary-600 text-white"
                : "bg-neutral-200 text-neutral-600"
            }`}
          >
            {live ? "LIVE · 30s" : "PAUSED"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} — retrying…
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-primary-100 bg-white p-6 shadow-sm">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
          {gridCells.map((row) =>
            row.cols.map((count, col) => {
              if (count === null) {
                return (
                  <span
                    key={`${row.key}-${col}`}
                    className="aspect-square rounded-[3px] bg-neutral-100"
                  />
                );
              }
              const intensity = count / maxCount;
              return (
                <span
                  key={`${row.key}-${col}`}
                  title={`${count} order${count === 1 ? "" : "s"} in this zone`}
                  className="aspect-square rounded-[3px]"
                  style={{
                    backgroundColor: `rgba(13, 148, 136, ${0.15 + intensity * 0.85})`,
                  }}
                />
              );
            }),
          )}
        </div>

        <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <span className="text-neutral-400">Density</span>
            <span className="inline-block h-3 w-3 rounded-sm bg-[rgba(13,148,136,0.15)]" />
            <span>low</span>
            <span className="inline-block h-3 w-3 rounded-sm bg-[rgba(13,148,136,0.85)]" />
            <span>high</span>
          </div>
          <span>
            Last updated{" "}
            {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"} · grid{" "}
            {GRID_COLS}×{GRID_ROWS} (~110 m cells)
          </span>
        </footer>
      </section>
    </main>
  );
}
