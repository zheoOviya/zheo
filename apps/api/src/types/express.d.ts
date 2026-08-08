// Webhook routes verify HMAC over the exact inbound bytes, so the JSON
// body parser preserves the raw payload for signature checks.
import "express";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export {};
