import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";
import { getCorrelationId } from "../lib/correlation";
import { AppError, fail } from "./envelope";

// Global error handling - every failure is returned in the API Envelope.
export function notFoundHandler(_req: Request, res: Response): void {
  fail(res, "NOT_FOUND", "Route not found", 404);
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    fail(res, err.code, err.message, err.status);
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({
    message: "unhandled_error",
    error: message,
    correlation_id: getCorrelationId(res),
  });
  fail(res, "INTERNAL_ERROR", "Internal server error", 500);
}
