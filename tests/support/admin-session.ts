import { expect, type Page } from "@playwright/test";
import { TEST_ADMIN_ACCESS_CODE } from "./admin-access-code";

/**
 * Signs this browser context in through the real admin endpoint, so the cookie it
 * carries afterwards is one the server actually issued.
 *
 * Asserted rather than hoped for: a server started without the admin code answers 503
 * here, and a test that silently continued would fail much later with a confusing
 * message about a missing list.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  const response = await page.request.post("/api/admin/session", {
    data: { accessCode: TEST_ADMIN_ACCESS_CODE },
  });

  expect(
    response.status(),
    "the test server must accept the admin code from playwright.config.ts",
  ).toBe(200);
}

/** Signs in through the visible panel, the way a project adult actually does it. */
export async function signInThroughTheAdminForm(page: Page): Promise<void> {
  await page.getByLabel("Projekt-Zugangscode").fill(TEST_ADMIN_ACCESS_CODE);
  await page.getByRole("button", { name: "Anmelden" }).click();
}
