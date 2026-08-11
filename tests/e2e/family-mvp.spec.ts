import { expect, test, type Locator, type Page } from "@playwright/test";
import { childMessageFor } from "@/app/child-submission-message";
import { avaloriaIdeas } from "@/content/avaloria-content";
import {
  childStatusLegend,
  childTopicLabelFor,
  childUnsafeVocabulary,
  type InternalCategory,
} from "@/content/content-source";
import { focusQuestion, otherOpenQuestions } from "@/content/open-questions";
import { createTextSubmission, submissionStatusLabel } from "@/domain/submissions/submission";

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

/**
 * The child-facing sentences, taken from the module that owns them rather than
 * retyped. The two failure reasons read differently on purpose, which is what lets a
 * test tell the retry's own outcome apart from the one the form is still showing.
 */
const messageFixture = createTextSubmission(
  { questionId: focusQuestion().id, originalText: answerText },
  { createId: () => "e2e-message-fixture", now: () => new Date("2026-08-11T00:00:00.000Z") },
);
const refusedMessage = childMessageFor({
  delivered: false,
  reason: "refused",
  submission: messageFixture,
});

function ideasOwnedBy(internalCategory: InternalCategory) {
  return avaloriaIdeas.filter((idea) => idea.internalCategory === internalCategory);
}

function myIdeasSection(page: Page) {
  return page.getByRole("region", { name: "Das hast du schon geschickt." });
}

/**
 * Longest transition on an element, in seconds. `.button` transitions two properties,
 * so reading only the first value would leave the slower one unchecked.
 */
async function settleSeconds(locator: Locator): Promise<number> {
  const durations = await locator.evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value)),
  );
  return Math.max(...durations);
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

/**
 * The legend teaches four signs and says what each one means. A submission badge that
 * wears one of them tells a child their own answer is "Schon dabei - das gehört schon
 * zu Avaloria", which is the exact claim this slice exists to keep unfakeable.
 */
test("the answer status badge borrows no sign from the idea legend", async ({ page }) => {
  await page.route(inboxRoute, (route) => route.abort("failed"));
  await page.goto("/");
  await sendAnswer(page);

  const myIdeas = myIdeasSection(page);
  const badge = myIdeas.locator(".my-idea-status");

  async function expectNoLegendSign(expected: string) {
    // Exact text, so an icon prepended to the label would fail here too.
    await expect(badge).toHaveText(expected);
    for (const status of childStatusLegend) {
      await expect(badge, `must not wear the "${status.label}" class`).not.toHaveClass(
        new RegExp(`\\bstatus-${status.id}\\b`),
      );
      await expect(badge, `must not wear the "${status.label}" icon`).not.toContainText(status.icon);
    }
  }

  // The legend shows exactly the signs it promises, and the badge adds none.
  await expect(page.locator(".status-card")).toHaveCount(childStatusLegend.length);
  await expectNoLegendSign(onDeviceLabel);

  await page.unroute(inboxRoute);
  await myIdeas.getByRole("button", { name: "Noch einmal senden" }).click();
  await expectNoLegendSign(arrivedLabel);
});

test("a failed retry explains itself where the child tapped it", async ({ page }) => {
  await page.route(inboxRoute, (route) => route.abort("failed"));
  await page.goto("/");
  await sendAnswer(page);

  const myIdeas = myIdeasSection(page);
  await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();

  // The retry meets a different kind of failure, so its sentence is distinguishable
  // from the one the form far above is still showing. Without that, a message left
  // behind at the top of the page could pass for the retry's own answer.
  await page.unroute(inboxRoute);
  await page.route(inboxRoute, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: "{}" }),
  );

  // Clicking scrolls the button into view, so the child really is at the bottom.
  await myIdeas.getByRole("button", { name: "Noch einmal senden" }).click();

  const outcome = page.getByRole("status").filter({ hasText: refusedMessage });
  await expect(outcome).toHaveCount(1);
  await expect(outcome).toBeVisible();
  // The point of this test: readable without scrolling back to the form.
  await expect(outcome).toBeInViewport();
  // And it really is inside the section the retry happened in.
  await expect(myIdeas.getByRole("status")).toHaveText(refusedMessage);

  // The retry failed, so nothing may have changed about what the entry claims.
  await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();
  await expect(myIdeas.getByText(answerText)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(arrivedLabel);
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

test("the answer form sits in the keyboard tab order and can be typed into", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByLabel("Deine Antwort");
  const submit = page.getByRole("button", { name: "Antwort speichern" });

  // The button stays disabled until there is something to send, and a disabled button
  // cannot take focus - so the tab-order check needs content in the field first.
  await textarea.fill(answerText);
  await expect(submit).toBeEnabled();

  // Tabbing backwards from the button is what proves the field is in the tab order.
  // Calling focus() on it and tabbing forward would prove only that focus() works.
  await submit.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(textarea).toBeFocused();

  // Clear it and retype with the keyboard alone, then tab forward again.
  await textarea.fill("");
  await page.keyboard.type(answerText);
  await expect(textarea).toHaveValue(answerText);
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
  await expect(submit).toBeEnabled();
});

test.describe("reduced motion", () => {
  // Playwright 1.62 carries reducedMotion inside contextOptions, not as a top-level
  // test option - the flat form does not typecheck.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("the whole flow works and needs no animation to operate", async ({ page }) => {
    await page.route(inboxRoute, (route) => route.abort("failed"));
    await page.goto("/");

    // Only values that actually differ with and without the setting are asserted.
    // An animationName check would be decoration: this stylesheet declares no
    // @keyframes at all, so it reads "none" even if reduced motion were broken.
    const submit = page.getByRole("button", { name: "Antwort speichern" });
    expect(await settleSeconds(submit)).toBeLessThan(0.001);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
      "auto",
    );

    // The section is reachable by its nav link without a scrolling animation.
    const myIdeas = myIdeasSection(page);
    await page.getByRole("link", { name: "Meine Ideen" }).click();
    await expect(myIdeas).toBeInViewport();

    await sendAnswer(page);
    await expect(myIdeas.getByText(onDeviceLabel)).toBeVisible();

    // The retry button is the one element inside the new section that transitions by
    // default, so it is where the override has to be observable rather than assumed.
    const retry = myIdeas.getByRole("button", { name: "Noch einmal senden" });
    expect(await settleSeconds(retry)).toBeLessThan(0.001);

    await page.unroute(inboxRoute);
    await retry.click();
    await expect(myIdeas.getByText(arrivedLabel)).toBeVisible();
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
