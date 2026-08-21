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
    // Frontend RTL suites run under their app-scoped vitest configs (jsdom):
    // consumer, vendor. Admin tests run under apps/admin/vitest.config.ts.
    exclude: ["**/node_modules/**", "apps/consumer/**", "apps/vendor/**", "apps/admin/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scope to what this suite actually exercises (API + db/types schema).
      // Frontends run under their own configs; packages/ui and qa scripts are
      // not covered here.
      include: ["apps/api/**", "packages/db/**", "packages/types/**"],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 65,
      },
    },
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
