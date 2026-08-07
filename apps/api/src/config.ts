import "dotenv/config";

// ============================================
// Config Module - simulates a Central Configuration Registry
// (e.g. AWS AppConfig / Consul). All values are read from the
// environment ONLY. Zero hardcoded secrets (EGS Layer 2.2).
// ============================================

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  env: optional("NODE_ENV", "development"),
  port: optionalInt("PORT", 3001),

  database: {
    url: optional("DATABASE_URL", "postgresql://user:password@localhost:5432/snakzap"),
  },

  redis: {
    url: optional("REDIS_URL", ""),
  },

  jwt: {
    accessSecret: optional("JWT_SECRET", "dev-access-secret-change-in-production"),
    refreshSecret: optional("JWT_REFRESH_SECRET", "dev-refresh-secret-change-in-production"),
    accessTtlSeconds: optionalInt("JWT_ACCESS_TTL_SECONDS", 15 * 60),
    refreshTtlSeconds: optionalInt("JWT_REFRESH_TTL_SECONDS", 7 * 24 * 60 * 60),
    refreshCookieName: optional("JWT_REFRESH_COOKIE_NAME", "snakzap_refresh"),
  },

  msg91: {
    authKey: optional("MSG91_AUTH_KEY", ""),
    templateId: optional("MSG91_TEMPLATE_ID", ""),
    otpTtlSeconds: optionalInt("OTP_TTL_SECONDS", 5 * 60),
  },

  razorpay: {
    keyId: optional("RAZORPAY_KEY_ID", ""),
    keySecret: optional("RAZORPAY_KEY_SECRET", ""),
    webhookSecret: optional("RAZORPAY_WEBHOOK_SECRET", ""),
  },

  petpooja: {
    // HMAC-SHA256 webhook signing secret issued by Petpooja.
    // Empty in dev/test -> mock signature mode accepts the
    // `valid_sig_` prefix (mirrors the Razorpay seam).
    webhookSecret: optional("PETPOOJA_WEBHOOK_SECRET", ""),
    apiBaseUrl: optional("PETPOOJA_API_BASE_URL", ""),
    merchantToken: optional("PETPOOJA_MERCHANT_TOKEN", ""),
    defaultRestaurantId: optional(
      "PETPOOJA_DEFAULT_RESTAURANT_ID",
      "a0000000-0000-4000-8000-000000000001",
    ),
  },

  cloudinary: {
    url: optional("CLOUDINARY_URL", ""),
  },

  googleMaps: {
    // P04 Traffic-based ETA. When empty the EtaService falls back to a
    // traffic-aware mock (haversine + IST rush-hour multiplier).
    apiKey: optional("GOOGLE_MAPS_API_KEY", ""),
    baseUrl: optional(
      "GOOGLE_MAPS_API_BASE_URL",
      "https://maps.googleapis.com/maps/api/distancematrix/json",
    ),
  },

  rateLimit: {
    otpMaxPerMinute: optionalInt("RATE_LIMIT_OTP_PER_MINUTE", 3),
    apiMaxPerMinute: optionalInt("RATE_LIMIT_API_PER_MINUTE", 100),
  },

  catalog: {
    cacheTtlRestaurants: optionalInt("CATALOG_CACHE_TTL_RESTAURANTS", 5 * 60),
    cacheTtlMenu: optionalInt("CATALOG_CACHE_TTL_MENU", 5 * 60),
    cacheTtlSearch: optionalInt("CATALOG_CACHE_TTL_SEARCH", 60),
    cacheTtlFilter: optionalInt("CATALOG_CACHE_TTL_FILTER", 5 * 60),
  },

  s3: {
    bucket: optional("S3_BUCKET", ""),
    region: optional("S3_REGION", "ap-south-1"),
    accessKeyId: optional("S3_ACCESS_KEY_ID", ""),
    secretAccessKey: optional("S3_SECRET_ACCESS_KEY", ""),
    cdnBaseUrl: optional("S3_CDN_BASE_URL", ""),
  },
} as const;

export type AppConfig = typeof config;
