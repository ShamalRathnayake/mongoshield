/**
 * Playwright configuration for the console's end-to-end tests (e2e/).
 *
 * The tests drive the BUILT console (`pnpm build` first) in Chromium against a real
 * mongod; e2e/global-setup.ts starts both. All specs share that one server, so
 * they run one at a time, in two projects:
 *
 *   journey   first-run setup → … → logout (e2e/journey.spec.ts): creates the admin,
 *             connections, storage, plan and backups everything else builds on
 *   features  roles, CSRF, theme, keyboard navigation, accessibility; runs after
 *             `journey` (a project dependency), so the records exist
 *
 * Run: `pnpm test:e2e` (or `pnpm exec playwright test`). Locally, export
 * MONGOMS_SYSTEM_BINARY=$(which mongod) to skip the mongod download.
 */

import { defineConfig, devices } from "@playwright/test";

const isCi = process.env.CI !== undefined;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One shared console: specs must not run side by side.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCi,
  retries: 0,
  // A backup, a restore and a drill run against a real mongod inside one test.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  // The HTML report (with screenshots and traces of failures) is what CI uploads.
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    // Fixed, so schedule previews and dates read the same on every machine.
    timezoneId: "UTC",
    locale: "en-US",
    // Without it, a click on a control that never appears waits for the whole test timeout.
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "journey", testMatch: "journey.spec.ts" },
    { name: "features", testIgnore: "journey.spec.ts", dependencies: ["journey"] },
  ],
});
