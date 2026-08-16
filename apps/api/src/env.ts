import { z } from "zod";
import { config } from "./config";

// ============================================
// Fail-fast production config validation.
//
// The API previously only *warned* when JWT secrets fell back to the
// well-known dev defaults. That meant a misconfigured production or
// staging deploy could boot with weak, guessable signing keys and silently
// mint forgeable tokens. This module hard-fails the process instead, so a
// bad deploy can never come up insecure.
//
// Dev/test (NODE_ENV != "production") still use the dev defaults so local
// development and CI keep working without secrets.
// ============================================

const DEV_SECRETS = new Set([
  "dev-access-secret-change-in-production",
  "dev-refresh-secret-change-in-production",
]);

const StrongSecret = z
  .string()
  .min(32, "must be at least 32 characters")
  .refine((v) => !DEV_SECRETS.has(v), "must not use the dev default value");

const ProductionSecretsSchema = z.object({
  JWT_SECRET: StrongSecret,
  JWT_REFRESH_SECRET: StrongSecret,
});

export function assertSecureConfig(): void {
  if (config.env !== "production") return;

  const secrets = ProductionSecretsSchema.safeParse({
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  });

  if (!secrets.success) {
    const issues = secrets.error.issues
      .map((i) => `${i.path.join(".")} ${i.message}`)
      .join("; ");
    throw new Error(
      `Refusing to start in production: invalid JWT configuration (${issues}). ` +
        "Set JWT_SECRET and JWT_REFRESH_SECRET to strong, unique values.",
    );
  }

  if (config.auth.allowDevAuthBypass) {
    throw new Error(
      "Refusing to start in production: ALLOW_DEV_AUTH_BYPASS must not be enabled.",
    );
  }
}
