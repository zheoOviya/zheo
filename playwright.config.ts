import { defineConfig, devices } from "@playwright/test";

// Role-based E2E layout. Each console lives on its own port (see each app's
// `dev` script) and all three talk to the single API on :3001. The API serves
// the shared catalog + identity + loyalty state, so the cross-agent spec can
// exercise one end-to-end lifecycle across all three consoles.
const PORT = {
  api: 3001,
  consumer: 3000,
  vendor: 3002,
  admin: 3003,
} as const;

const baseURLs = {
  consumer: `http://localhost:${PORT.consumer}`,
  vendor: `http://localhost:${PORT.vendor}`,
  admin: `http://localhost:${PORT.admin}`,
} as const;

export default defineConfig({
  testDir: "./e2e",
  // Single worker by default: the three consoles share one in-memory API whose
  // OTP store is keyed by phone, so parallel logins for the same seeded demo
  // account would race. Bump `workers` only when running against isolated
  // database-backed stacks.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "consumer",
      testDir: "./e2e/consumer",
      use: { ...devices["Desktop Chrome"], baseURL: baseURLs.consumer },
    },
    {
      name: "vendor",
      testDir: "./e2e/vendor",
      use: { ...devices["Desktop Chrome"], baseURL: baseURLs.vendor },
    },
    {
      name: "admin",
      testDir: "./e2e/admin",
      use: { ...devices["Desktop Chrome"], baseURL: baseURLs.admin },
    },
    {
      // No baseURL on purpose: this spec opens all three consoles explicitly.
      name: "cross-agent",
      testDir: "./e2e/cross-agent",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @snakzap/api dev",
      url: `http://localhost:${PORT.api}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: "pnpm --filter @snakzap/consumer dev",
      url: baseURLs.consumer,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: "pnpm --filter @snakzap/vendor dev",
      url: baseURLs.vendor,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: "pnpm --filter @snakzap/admin dev",
      url: baseURLs.admin,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
