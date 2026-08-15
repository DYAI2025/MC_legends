/**
 * The invented admin access code the browser tests sign in with.
 *
 * Deliberately DIFFERENT from TEST_FAMILY_ACCESS_CODE, and that difference is what the
 * separation tests actually prove: if the two were equal, "the family code does not
 * open the admin inbox" would pass for the wrong reason and keep passing after a
 * regression that merged the two identities.
 *
 * Test data, not a secret: no deployment reads this file, and the real code is supplied
 * through AVALORIA_ADMIN_ACCESS_CODE at run time.
 *
 * This module deliberately imports nothing, so the Playwright config can read it.
 */
export const TEST_ADMIN_ACCESS_CODE = "projekt-postfach-testcode-8150";
