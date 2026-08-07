import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// ============================================
// Observability (EOS 1.5): x-correlation-id
// Generate or propagate a correlation id per request.
// Stored on res.locals, propagated to all request logs
// and outbound headers / emitted events.
// ============================================

export const CORRELATION_HEADER = "x-correlation-id";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      correlationId: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    }
  }
}

export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header(CORRELATION_HEADER);
  const id =
    inbound && inbound.length > 0 && inbound.length <= 128
      ? inbound
      : randomUUID();
  res.locals.correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}

export function getCorrelationId(res: Response): string {
  return res.locals.correlationId ?? "unknown";
}

export function generateEventMetadata(
  res: Response,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    correlation_id: getCorrelationId(res),
    ...extra,
  };
}
