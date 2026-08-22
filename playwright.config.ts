import { defineConfig, devices } from "@playwright/test";
import { TEST_ADMIN_ACCESS_CODE } from "./tests/support/admin-access-code";
import { TEST_FAMILY_ACCESS_CODE } from "./tests/support/family-access-code";

const port = Number(process.env.E2E_PORT ?? 3000);
const host = "127.0.0.1";

/**
 * MCL-35 runs against a SECOND server, on its own port and its own data directories.
 *
 * Closing a question is global state: it changes what every visitor is asked. This suite
 * is `fullyParallel`, and two existing specs assert the seeded question by name
 * (tests/e2e/foundation.spec.ts and tests/e2e/family-mvp.spec.ts) - so a spec that closed
 * one on the shared server would break them at whatever moment the two happened to
 * overlap, which is the worst kind of failure to debug.
 *
 * A second server rather than weakening `fullyParallel` for the whole suite: the
 * constraint is "these tests own the question state", not "nothing may run in parallel",
 * and making every other spec slower to accommodate one is the wrong trade. The lifecycle
 * project runs its own file serially instead.
 *
 * Its own inbox and media directories too, not just its own question directory: the
 * lifecycle specs submit answers and recordings, and those must not land in the same
 * .data the rest of the suite reads.
 */
const lifecyclePort = Number(process.env.E2E_LIFECYCLE_PORT ?? 3101);
const lifecycleData = ".data/e2e-lifecycle";

/**
 * The server under test gets the invented family code the browser tests sign in with.
 * The rate limits are raised well above the defaults on purpose: every test signs in,
 * they run in parallel from one address, and CI retries them - the abuse brake is
 * proven in the unit tests, and leaving it at its production value here would fail
 * tests for a reason that has nothing to do with what they check.
 */
const familyServerEnvironment = {
  AVALORIA_FAMILY_ACCESS_CODE: TEST_FAMILY_ACCESS_CODE,
  // MCL-50. A different value from the family code above, so the browser tests can
  // prove the two identities are actually separate rather than merely differently named.
  AVALORIA_ADMIN_ACCESS_CODE: TEST_ADMIN_ACCESS_CODE,
  AVALORIA_SESSION_RATE_LIMIT: "500",
  AVALORIA_SESSION_GLOBAL_RATE_LIMIT: "500",
  AVALORIA_INBOX_RATE_LIMIT: "500",
  // MCL-49. The audio bucket defaults to 10/minute - deliberately tighter than the text
  // inbox's 30, because the resource it protects is disk rather than request count. Every
  // spec that uploads a recording runs from one address in parallel, so the production
  // value would fail tests for a reason that has nothing to do with what they check. The
  // brake itself is proven in tests/unit/audio-inbox-route.test.ts.
  AVALORIA_AUDIO_RATE_LIMIT: "500",
  AVALORIA_ADMIN_RATE_LIMIT: "500",
  AVALORIA_ADMIN_SESSION_RATE_LIMIT: "500",
  AVALORIA_ADMIN_SESSION_GLOBAL_RATE_LIMIT: "500",
};

/**
 * The lifecycle server's environment: the shared one plus its own directories. Spread
 * rather than restated, so a limit raised for the main server is raised for this one too
 * - two drifting copies would fail one project for a reason that has nothing to do with
 * what it tests.
 */
const lifecycleServerEnvironment = {
  ...familyServerEnvironment,
  AVALORIA_QUESTION_DIR: `${lifecycleData}/questions`,
  AVALORIA_INBOX_DIR: `${lifecycleData}/inbox`,
  AVALORIA_MEDIA_DIR: `${lifecycleData}/media`,
  // A build directory of its own, LOCALLY ONLY: `next dev` locks the one it uses and
  // refuses a second instance for it. In CI both servers are `next start` over the one
  // artefact the build step produced, which takes no such lock - and pointing this at a
  // directory that build never wrote would fail the second server outright.
  ...(process.env.CI ? {} : { NEXT_DIST_DIR: ".next-lifecycle" }),
};

/** The one spec that changes which questions are open, and the only one on that server. */
const LIFECYCLE_SPEC = "**/question-lifecycle.spec.ts";

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
      // Everything except the specs that retire questions for the whole server.
      testIgnore: LIFECYCLE_SPEC,
    },
    {
      name: "chromium-lifecycle",
      use: { ...devices["Desktop Chrome"], baseURL: `http://${host}:${lifecyclePort}` },
      testMatch: LIFECYCLE_SPEC,
      // Its own server, but still one server: these tests share the question state with
      // each other, so they run one at a time. The spec also restores the board between
      // tests, which is what makes a CI retry start from the same place as the first
      // attempt.
      fullyParallel: false,
    },
  ],
  webServer: [
    {
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
    {
      command: process.env.CI
        ? `npm run start -- --hostname ${host} --port ${lifecyclePort}`
        : `npm run dev -- --hostname ${host} --port ${lifecyclePort}`,
      url: `http://${host}:${lifecyclePort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: lifecycleServerEnvironment,
    },
  ],
});
