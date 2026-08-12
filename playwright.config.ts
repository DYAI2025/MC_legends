import { defineConfig, devices } from "@playwright/test";
import { TEST_FAMILY_ACCESS_CODE } from "./tests/support/family-access-code";

const port = Number(process.env.E2E_PORT ?? 3000);
const host = "127.0.0.1";

/**
 * The server under test gets the invented family code the browser tests sign in with.
 * The rate limits are raised well above the defaults on purpose: every test signs in,
 * they run in parallel from one address, and CI retries them - the abuse brake is
 * proven in the unit tests, and leaving it at its production value here would fail
 * tests for a reason that has nothing to do with what they check.
 */
const familyServerEnvironment = {
  AVALORIA_FAMILY_ACCESS_CODE: TEST_FAMILY_ACCESS_CODE,
  AVALORIA_SESSION_RATE_LIMIT: "500",
  AVALORIA_INBOX_RATE_LIMIT: "500",
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // CI runs the production server built by the preceding build step.
    command: process.env.CI
      ? `npm run start -- --hostname ${host} --port ${port}`
      : `npm run dev -- --hostname ${host} --port ${port}`,
    url: `http://${host}:${port}/api/health`,
    // Locally this reuses a dev server that may have been started without the family
    // code; the sign-in helper fails loudly in that case rather than silently skipping.
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: familyServerEnvironment,
  },
});
