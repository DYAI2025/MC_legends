import { expect, test } from "@playwright/test";

const heroHeading = "Deine Ideen machen Avaloria größer.";
const openQuestionHeading = "Welche Farbe soll der Fluss haben?";

function heroRegion(page: import("@playwright/test").Page) {
  return page.getByRole("region", { name: heroHeading });
}

test("Avaloria page is available without forbidden franchise references", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: heroHeading })).toBeVisible();
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
  const hero = heroRegion(page);
  await expect(hero.getByRole("link")).toHaveCount(2);
  await expect(hero.getByRole("link", { name: /Idee teilen/ })).toBeVisible();
  await expect(hero.getByRole("link", { name: /Frage beantworten/ })).toBeVisible();
});

test("the open question uses simple language and a disabled empty answer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: openQuestionHeading })).toBeVisible();
  await expect(page.getByLabel("Deine Antwort")).toBeVisible();
  await expect(page.getByRole("button", { name: "Antwort speichern" })).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("Divergenzphase");
});

test("the child view keeps six easy-to-understand idea groups", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".category-chip")).toHaveCount(7);

  const historyChip = page.getByRole("button", { name: "Geschichte & Welt", pressed: false });
  await historyChip.click();
  await expect(page.getByRole("button", { name: "Geschichte & Welt", pressed: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Das Tor ins grüne Tal" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Die Lichter von Avaloria" })).toBeVisible();
  await expect(page.locator(".idea-card")).toHaveCount(2);
});
