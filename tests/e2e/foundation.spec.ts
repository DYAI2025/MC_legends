import { expect, test } from "@playwright/test";

test("foundation page is available without forbidden franchise references", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hier entsteht eure Welt." })).toBeVisible();
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("harry potter");
  expect(text).not.toContain("hogwarts");
});

test("health endpoint reports ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});
