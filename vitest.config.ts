import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
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
