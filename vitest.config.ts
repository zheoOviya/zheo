import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/consumer"),
    },
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    // Consumer RTL suites run under apps/consumer/vitest.config.ts (jsdom).
    exclude: ["**/node_modules/**", "apps/consumer/**"],
    environment: "node",
    env: {
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "test-access-secret-at-least-32-characters-long",
      JWT_REFRESH_SECRET: "test-refresh-secret-at-least-32-characters-long",
      MSG91_AUTH_KEY: "test-msg91-key",
      CLOUDINARY_URL: "",
    },
  },
});
