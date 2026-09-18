import { defineConfig, devices } from "@playwright/test";

/**
 * Frontend E2E Test Configuration
 *
 * Runs automated browser tests against the tenant portal UI.
 * Tests verify the actual user workflows and prevent regressions
 * in the seven portal screens (Tasks #47–#53).
 *
 * Requires the API backend and frontend dev server to be running:
 *   API: npm run dev (in apps/api)
 *   Web: npm run dev (in apps/web)
 *
 * Run tests:
 *   npm run test:e2e           # Run all tests
 *   npm run test:e2e -- --ui   # Run with UI
 *   npm run test:e2e -- --headed # Run headed (see browser)
 */

export default defineConfig({
  testDir: "./src/**/*.e2e.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
