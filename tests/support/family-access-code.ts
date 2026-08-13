/**
 * The invented access code every test signs in with.
 *
 * Deliberately a single source: playwright.config.ts hands it to the server it starts,
 * the browser tests type it, and the unit tests mint sessions from it. Two copies
 * would drift and the browser tests would fail for a reason that has nothing to do
 * with the product.
 *
 * It is test data, not a secret: no deployment reads this file, and the real code is
 * supplied through AVALORIA_FAMILY_ACCESS_CODE at run time.
 *
 * This module deliberately imports nothing, so the Playwright config can read it.
 */
export const TEST_FAMILY_ACCESS_CODE = "tal-der-lampen-testcode-4711";
