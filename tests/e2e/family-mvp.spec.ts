import { expect, test, type Page } from "@playwright/test";
import { avaloriaIdeas } from "@/content/avaloria-content";
import {
  childTopicLabelFor,
  childUnsafeVocabulary,
  type InternalCategory,
} from "@/content/content-source";
import { focusQuestion, otherOpenQuestions } from "@/content/open-questions";
import { submissionStatusLabel } from "@/domain/submissions/submission";

const removedDemoStrings = [
  "Das Tor ins grüne Tal",
  "Die Lichter von Avaloria",
  "Der Brückenhüter",
  "Die Werkstatt im Baum",
];

/** The two exact child-facing sentences MCL-36 exists to keep apart. */
const arrivedLabel = submissionStatusLabel("SERVER_ACKNOWLEDGED");
const onDeviceLabel = submissionStatusLabel("LOCAL_ONLY");

const answerText = "Mein Tier ist ein kleiner Steinwolf.";
const inboxRoute = "**/api/inbox/submissions";

function ideasOwnedBy(internalCategory: InternalCategory) {
  return avaloriaIdeas.filter((idea) => idea.internalCategory === internalCategory);
}

function myIdeasSection(page: Page) {
  return page.getByRole("region", { name: "Das hast du schon geschickt." });
}

async function sendAnswer(page: Page) {
  await page.getByLabel("Deine Antwort").fill(answerText);
  await page.getByRole("button", { name: "Antwort speichern" }).click();
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

test("exactly one open question is in focus and the demo question is gone", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".question-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: focusQuestion().title })).toBeVisible();

  const body = page.locator("body");
  await expect(body).not.toContainText("Welche Farbe soll der Fluss haben?");
  await expect(body).not.toContainText("Ich stelle mir den Fluss so vor");

  await expect(page.getByRole("heading", { name: "Diese Fragen kommen später dran" })).toBeVisible();
  await expect(page.locator(".upcoming-questions li")).toHaveCount(otherOpenQuestions().length);
});

test("the answer list starts empty and invites a first idea", async ({ page }) => {
  await page.goto("/");
  const myIdeas = myIdeasSection(page);
  await expect(myIdeas).toBeVisible();
  await expect(myIdeas.getByText("Noch keine Antwort. Deine erste Idee kommt hier hin.")).toBeVisible();
  await expect(myIdeas.locator(".my-idea")).toHaveCount(0);
});

test("a sent answer becomes visible as arrived in the project", async ({ page }) => {
  await page.goto("/");
  await sendAnswer(page);

  const myIdeas = myIdeasSection(page);
  await expect(myIdeas.getByText(arrivedLabel)).toBeVisible();
  await expect(myIdeas.getByText(answerText)).toBeVisible();
  // Nothing arrived may still offer a retry.
  await expect(myIdeas.getByRole("button", { name: "Noch einmal senden" })).toHaveCount(0);
});

test("an unreachable project inbox keeps the answer on the device without a fake confirmation", async ({
  page,
}) => {
  await page.route(inboxRoute, (route) => route.abort("failed"));
  await page.goto("/");
  await sendAnswer(page);

  const myIdeas = myIdeasSection(page);
  await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();
  await expect(myIdeas.getByText(answerText)).toBeVisible();
  // The one assertion this whole slice exists for.
  await expect(page.locator("body")).not.toContainText(arrivedLabel);
});

test("a failed answer survives a reload and can be sent again from the keyboard", async ({ page }) => {
  await page.route(inboxRoute, (route) => route.abort("failed"));
  await page.goto("/");
  await sendAnswer(page);

  const myIdeas = myIdeasSection(page);
  await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();

  await page.reload();
  await expect(myIdeas.getByText(answerText)).toBeVisible();
  await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(arrivedLabel);

  await page.unroute(inboxRoute);
  const retry = myIdeas.getByRole("button", { name: "Noch einmal senden" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(myIdeas.getByText(arrivedLabel)).toBeVisible();
  // The original wording survived both the failure and the retry.
  await expect(myIdeas.getByText(answerText)).toBeVisible();
  await expect(myIdeas.getByText(onDeviceLabel)).toHaveCount(0);
});

test("the child view stays free of technical vocabulary in the failure case", async ({ page }) => {
  await page.route(inboxRoute, (route) => route.abort("failed"));
  await page.goto("/");
  await sendAnswer(page);
  await expect(myIdeasSection(page).getByText(onDeviceLabel)).toBeVisible();

  const visibleText = await page.locator("body").innerText();
  // Guard against a locator that silently matches nothing: the failure copy has to be
  // in the text this assertion reads, otherwise the loop below proves nothing.
  expect(visibleText).toContain(onDeviceLabel);

  const forbidden = [...childUnsafeVocabulary, "HTTP", "500", "503", "fetch", "Timeout", "Stack"];
  for (const word of forbidden) {
    // Word boundaries, not substrings: German "Papier" contains "api". Case-insensitive,
    // because "server" is as unfit in a child view as "Server".
    const mention = new RegExp(`\\b${word}\\b`, "iu");
    expect(visibleText, `the child view must not expose "${word}"`).not.toMatch(mention);
  }
});

test("an empty or whitespace-only answer cannot be sent", async ({ page }) => {
  await page.goto("/");
  const submit = page.getByRole("button", { name: "Antwort speichern" });
  await expect(submit).toBeDisabled();

  await page.getByLabel("Deine Antwort").fill("     ");
  await expect(submit).toBeDisabled();
  await expect(myIdeasSection(page).locator(".my-idea")).toHaveCount(0);
});

test("the answer form is reachable and usable with the keyboard", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByLabel("Deine Antwort");
  await textarea.focus();
  await expect(textarea).toBeFocused();

  await page.keyboard.type(answerText);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Antwort speichern" })).toBeFocused();
});

test.describe("reduced motion", () => {
  // Playwright 1.62 carries reducedMotion inside contextOptions, not as a top-level
  // test option - the flat form does not typecheck.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the whole flow works and needs no animation to operate", async ({ page }) => {
    await page.goto("/");

    // The reduced-motion stylesheet really applied - otherwise the rest of this test
    // would only prove that the flow works, not that it works without motion.
    const submit = page.getByRole("button", { name: "Antwort speichern" });
    const buttonMotion = await submit.evaluate((element) => {
      const style = getComputedStyle(element);
      return { transitionDuration: style.transitionDuration, animationName: style.animationName };
    });
    expect(Number.parseFloat(buttonMotion.transitionDuration)).toBeLessThan(0.001);
    expect(buttonMotion.animationName).toBe("none");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
      "auto",
    );

    // The section is reachable by its nav link without a scrolling animation.
    const myIdeas = myIdeasSection(page);
    await page.getByRole("link", { name: "Meine Ideen" }).click();
    await expect(myIdeas).toBeInViewport();

    await sendAnswer(page);
    await expect(myIdeas.getByText(arrivedLabel)).toBeVisible();

    // The new list entry is readable on arrival: nothing is hidden behind a reveal.
    const entryMotion = await myIdeas.locator(".my-idea").evaluate((element) => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, animationName: style.animationName };
    });
    expect(entryMotion.opacity).toBe("1");
    expect(entryMotion.animationName).toBe("none");
  });
});

test.describe("small screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the question and the answer list stay usable on a phone", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 2, name: focusQuestion().title }),
    ).toBeVisible();

    await sendAnswer(page);
    const myIdeas = myIdeasSection(page);
    await expect(myIdeas.getByText(arrivedLabel)).toBeVisible();
    await expect(myIdeas.getByText(answerText)).toBeVisible();
  });
});
