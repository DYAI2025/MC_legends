import { expect, test } from "@playwright/test";

test("Avaloria page is available without forbidden franchise references", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Willkommen in Avaloria." })).toBeVisible();
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("harry potter");
  expect(text).not.toContain("hogwarts");
});

test("health endpoint reports ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});

test("status cards explain the four child-facing states", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".status-card")).toHaveCount(4);
  await expect(page.getByText("Noch offen", { exact: true })).toBeVisible();
  await expect(page.getByText("Das ist noch nicht entschieden.", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Canon");
});

test("hero has two clear primary actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".hero-actions .button")).toHaveCount(2);
  await expect(page.getByRole("link", { name: /Idee teilen/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Frage beantworten/ })).toBeVisible();
});
