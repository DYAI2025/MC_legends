import { expect, type Page } from "@playwright/test";
import { TEST_FAMILY_ACCESS_CODE } from "./family-access-code";

/**
 * Signs this browser context in through the real endpoint, so the session cookie it
 * carries afterwards is one the server actually issued.
 *
 * `page.request` shares the context's cookie jar, so the page navigations that follow
 * are signed in. It is asserted rather than hoped for: a server started without the
 * family code answers 503 here, and a test that silently continued would then fail
 * much later with a confusing message about a missing form.
 */
export async function signInAsFamily(page: Page): Promise<void> {
  const response = await page.request.post("/api/family/session", {
    data: { accessCode: TEST_FAMILY_ACCESS_CODE },
  });

  expect(
    response.status(),
    "the test server must accept the family code from playwright.config.ts",
  ).toBe(200);
}

/** Signs in through the visible panel, the way a family actually does it. */
export async function signInThroughTheForm(page: Page): Promise<void> {
  await page.getByLabel("Familien-Code").fill(TEST_FAMILY_ACCESS_CODE);
  await page.getByRole("button", { name: "Weiter" }).click();
}
