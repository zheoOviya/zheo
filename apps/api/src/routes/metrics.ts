import { Router } from "express";

// ============================================
// Observability (EOS 1.5): /metrics placeholder
// Prometheus RED (Rate, Errors, Duration) counters.
// Backed by an in-memory array (no external deps yet).
// ============================================

export const metrics = {
  requests: 0,
  errors: 0,
  totalDurationMs: 0,
};

export const metricsRouter: Router = Router();

metricsRouter.get("/", (_req, res) => {
  const ratePerSec = metrics.requests > 0 ? metrics.requests / 60 : 0;
  const p95 = metrics.requests > 0 ? metrics.totalDurationMs / metrics.requests : 0;
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(
    [
      "# HELP snakzap_http_requests_total Total HTTP requests",
      "# TYPE snakzap_http_requests_total counter",
      `snakzap_http_requests_total ${metrics.requests}`,
      "# HELP snakzap_http_errors_total Total HTTP errors",
      "# TYPE snakzap_http_errors_total counter",
      `snakzap_http_errors_total ${metrics.errors}`,
      "# HELP snakzap_http_duration_avg_seconds Average request duration (seconds)",
      "# TYPE snakzap_http_duration_avg_seconds gauge",
      `snakzap_http_duration_avg_seconds ${(p95 / 1000).toFixed(4)}`,
      "# HELP snakzap_http_rate_per_minute Request rate per minute (RED rate)",
      "# TYPE snakzap_http_rate_per_minute gauge",
      `snakzap_http_rate_per_minute ${ratePerSec.toFixed(4)}`,
    ].join("\n") + "\n",
  );
});
