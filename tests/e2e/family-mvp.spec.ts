import { expect, test } from "@playwright/test";
import { avaloriaIdeas } from "@/content/avaloria-content";
import { childTopicLabelFor, type InternalCategory } from "@/content/content-source";

const removedDemoStrings = [
  "Das Tor ins grüne Tal",
  "Die Lichter von Avaloria",
  "Der Brückenhüter",
  "Die Werkstatt im Baum",
];

function ideasOwnedBy(internalCategory: InternalCategory) {
  return avaloriaIdeas.filter((idea) => idea.internalCategory === internalCategory);
}

test("the page no longer serves the Sprint-1 demo cards", async ({ page }) => {
  await page.goto("/");
  const body = page.locator("body");
  for (const demo of removedDemoStrings) {
    await expect(body).not.toContainText(demo);
  }
});

test("the page shows sourced project content and keeps prologue apart from the main story", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Die Druhen", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Die vier Elementschwerter" })).toBeVisible();

  await expect(page.getByText(`Thema: ${childTopicLabelFor("prologue")}`)).toHaveCount(
    ideasOwnedBy("prologue").length,
  );
  await expect(page.getByText(`Thema: ${childTopicLabelFor("main-story")}`)).toHaveCount(
    ideasOwnedBy("main-story").length,
  );
});
