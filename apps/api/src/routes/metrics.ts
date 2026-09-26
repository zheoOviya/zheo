import { Router } from "express";

// ============================================
// Observability (EOS 1.5): /metrics
// Prometheus RED (Rate, Errors, Duration) metrics.
// Backed by in-memory state (no external deps yet).
// ============================================

// Trailing window for snakzap_http_rate_per_minute. Requests are counted over
// the last RATE_WINDOW_MS so the value matches the metric unit (requests/min).
export const RATE_WINDOW_MS = 60_000;

export const metrics = {
  requests: 0,
  errors: 0,
  totalDurationMs: 0,
};

// Completion timestamps (epoch ms) of requests that finished within the
// trailing rate window. Pruned on write and read so storage stays bounded.
let completedAtMs: number[] = [];

// Record a request at the moment its response finished. `nowMs` is injectable
// so callers/tests can pin the completion instant.
export function recordCompletedRequest(nowMs: number = Date.now()): void {
  completedAtMs.push(nowMs);
  pruneRateWindow(nowMs);
}

// Completed requests within the trailing RATE_WINDOW_MS ending at `nowMs`.
export function getRatePerMinute(nowMs: number = Date.now()): number {
  pruneRateWindow(nowMs);
  return completedAtMs.length;
}

// Current number of retained completion timestamps (bounded by the window).
export function getRateWindowSize(): number {
  return completedAtMs.length;
}

export function resetMetricsForTests(): void {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.totalDurationMs = 0;
  completedAtMs = [];
}

// Window is half-open: (nowMs - RATE_WINDOW_MS, nowMs]. Completions at exactly
// the cutoff are dropped, so an event ages out as soon as it is 60s old.
function pruneRateWindow(nowMs: number): void {
  const cutoff = nowMs - RATE_WINDOW_MS;
  let drop = 0;
  while (drop < completedAtMs.length) {
    const ts = completedAtMs[drop];
    if (ts === undefined || ts > cutoff) break;
    drop += 1;
  }
  if (drop > 0) completedAtMs.splice(0, drop);
}

export const metricsRouter: Router = Router();

metricsRouter.get("/", (_req, res) => {
  const meanDurationMs =
    metrics.requests > 0 ? metrics.totalDurationMs / metrics.requests : 0;
  const ratePerMinute = getRatePerMinute();
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(
    [
      "# HELP snakzap_http_requests_total Total HTTP requests",
      "# TYPE snakzap_http_requests_total counter",
      `snakzap_http_requests_total ${metrics.requests}`,
      "# HELP snakzap_http_errors_total Total HTTP responses with status >= 400",
      "# TYPE snakzap_http_errors_total counter",
      `snakzap_http_errors_total ${metrics.errors}`,
      "# HELP snakzap_http_duration_avg_seconds Average request duration (seconds)",
      "# TYPE snakzap_http_duration_avg_seconds gauge",
      `snakzap_http_duration_avg_seconds ${(meanDurationMs / 1000).toFixed(4)}`,
      "# HELP snakzap_http_rate_per_minute Completed requests in the trailing 60s window",
      "# TYPE snakzap_http_rate_per_minute gauge",
      `snakzap_http_rate_per_minute ${ratePerMinute.toFixed(4)}`,
    ].join("\n") + "\n",
  );
});
