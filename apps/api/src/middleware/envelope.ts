import type { NextFunction, Request, Response } from "express";

// ============================================
// API Governance (EOS 1.4) + PRD Section 4
// Envelope: { success: boolean, data: T, error: { code, message } | null }
// ============================================

export type EnvelopeData = unknown;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }
}

export function ok(
  res: Response,
  data: EnvelopeData,
  status = 200,
): Response {
  return res.status(status).json({ success: true, data, error: null });
}

export function fail(
  res: Response,
  code: string,
  message: string,
  status = 400,
): Response {
  return res.status(status).json({
    success: false,
    data: null,
    error: { code, message },
  });
}

export function sendAppError(res: Response, err: AppError): Response {
  return fail(res, err.code, err.message, err.status);
}

type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
