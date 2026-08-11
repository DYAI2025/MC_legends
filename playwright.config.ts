import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3000);
const host = "127.0.0.1";

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
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
