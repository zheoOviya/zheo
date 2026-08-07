import { z } from "zod";

// PRD Section 4: API Envelope
// { success: boolean, data: {}, error: { code, message } | null }
export const ErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export function createEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean(),
    data: z.union([dataSchema, z.null()]),
    error: ErrorDetailSchema.nullable(),
  });
}

export const ApiEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().nullable(),
  error: ErrorDetailSchema.nullable(),
});
export type ApiEnvelope<T = unknown> = {
  success: boolean;
  data: T | null;
  error: ErrorDetail | null;
};

export function successEnvelope<T>(data: T): ApiEnvelope<T> {
  return { success: true, data, error: null };
}

export function errorEnvelope(code: string, message: string): ApiEnvelope<null> {
  return { success: false, data: null, error: { code, message } };
}
