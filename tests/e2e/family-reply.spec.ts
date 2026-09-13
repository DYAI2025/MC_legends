import { expect, test, type Page } from "@playwright/test";
import { signInAsFamily } from "../support/family-session";
import { signInAsAdmin } from "../support/admin-session";
import { expectChildSafe } from "../support/child-safe";
import { FAMILY_REPLIER_LABEL } from "@/app/reply-message";

/**
 * MCL-74. The loop, end to end, through the real surfaces.
 *
 * The unit suites already prove the store, the routes and the copy. What only a browser
 * can prove is that the three meet: a child types an idea, an adult answers it through
 * the form they will actually use, and the answer is on the child's page after a reload -
 * with exactly one question and nothing in it a child should not read.
 *
 * Two contexts rather than two tabs, because they hold different sessions. A single
 * context signing in as both would prove nothing about the gate that separates them.
 */

const IDEA = "Ein Wolf der im Dunkeln leuchtet";
const UNDERSTOOD = "Du möchtest einen Wolf, der im Dunkeln leuchtet.";
const QUESTION = "Welche Farbe soll das Leuchten haben?";

async function submitIdea(page: Page, text: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Deine Antwort").fill(text);
  await page.getByRole("button", { name: "Antwort speichern" }).click();
  // Waits for the server acknowledgement, not for the local save: the reply this test is
  // really about cannot exist until the submission is in the inbox.
  await expect(page.locator("#meine-ideen").getByText(text)).toBeVisible({ timeout: 15_000 });
}

/*
  Two browser contexts, a real submission and a real reply is more than the default
  30 s allows on a cold dev server. Raised rather than worked around: the flow is the
  product, and splitting it into faster pieces would stop proving that it joins up.
*/
test.describe.configure({ timeout: 90_000 });

test.describe("Papa antwortet", () => {
  test("a child's idea comes back as one question they can read", async ({ browser }) => {
    const childContext = await browser.newContext();
    const adultContext = await browser.newContext();

    try {
      const child = await childContext.newPage();
      await signInAsFamily(child);
      await submitIdea(child, IDEA);

      // Before any reply exists, the section is honest about it rather than empty.
      await child.reload();
      const section = child.locator("#antworten");
      await expect(section).toBeVisible();
      await expect(section.getByText(/Noch keine Antwort/u)).toBeVisible();

      const adult = await adultContext.newPage();
      await signInAsAdmin(adult);
      await adult.goto("/admin");

      const card = adult.locator(".admin-reply").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByLabel(/Verstanden/u).fill(UNDERSTOOD);
      await card.getByLabel(/Eine Frage an dich/u).fill(QUESTION);
      await card.getByRole("button", { name: "Antwort senden" }).click();

      // It shows up in the adult's own history without a reload.
      await expect(card.getByText(UNDERSTOOD)).toBeVisible({ timeout: 15_000 });

      await child.reload();
      await expect(section.getByText(UNDERSTOOD)).toBeVisible({ timeout: 15_000 });
      await expect(section.getByText(QUESTION)).toBeVisible();

      // Exactly one question mark in the whole card: the promise the shape rules exist
      // to keep, checked where a child would actually meet it.
      const questionText = await section.locator(".reply-question").first().innerText();
      expect(questionText.match(/\?/gu)?.length).toBe(1);

      await expect(section.getByText(new RegExp(FAMILY_REPLIER_LABEL, "u")).first()).toBeVisible();

      const visible = await section.innerText();
      expectChildSafe(visible, "the reply section a child reads");
    } finally {
      await childContext.close().catch(() => undefined);
      await adultContext.close().catch(() => undefined);
    }
  });

  test("the adult is told what to fix when the reply asks two questions", async ({ browser }) => {
    const childContext = await browser.newContext();
    const adultContext = await browser.newContext();

    try {
      const child = await childContext.newPage();
      await signInAsFamily(child);
      await submitIdea(child, "Ein Stein der singt");

      const adult = await adultContext.newPage();
      await signInAsAdmin(adult);
      await adult.goto("/admin");

      const card = adult.locator(".admin-reply").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByLabel(/Verstanden/u).fill("Du möchtest einen Stein, der singt.");
      await card.getByLabel(/Eine Frage an dich/u).fill("Welche Farbe? Und wie groß?");
      await card.getByRole("button", { name: "Antwort senden" }).click();

      await expect(card.getByText(/Genau eine Frage/u)).toBeVisible({ timeout: 15_000 });
    } finally {
      await childContext.close().catch(() => undefined);
      await adultContext.close().catch(() => undefined);
    }
  });

  test("offers to read the reply aloud, and pressing it does not break the page", async ({
    browser,
  }) => {
    const childContext = await browser.newContext();
    const adultContext = await browser.newContext();

    try {
      const child = await childContext.newPage();
      await signInAsFamily(child);
      await submitIdea(child, "Ein Vogel aus Glas");

      const adult = await adultContext.newPage();
      await signInAsAdmin(adult);
      await adult.goto("/admin");
      const card = adult.locator(".admin-reply").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByLabel(/Verstanden/u).fill("Du möchtest einen Vogel aus Glas.");
      await card.getByLabel(/Eine Frage an dich/u).fill("Wo soll er wohnen?");
      await card.getByRole("button", { name: "Antwort senden" }).click();
      await expect(card.getByText("Du möchtest einen Vogel aus Glas.")).toBeVisible({
        timeout: 15_000,
      });

      await child.reload();
      const section = child.locator("#antworten");
      await expect(section.getByText("Wo soll er wohnen?")).toBeVisible({ timeout: 15_000 });

      // Chromium has speechSynthesis, so the button is expected here. Where a device has
      // no voice the button is absent rather than disabled - which is why this asserts on
      // presence and then on the page still working, not on any sound.
      const readAloud = section.getByRole("button", { name: "Vorlesen" }).first();
      await expect(readAloud).toBeVisible();
      await readAloud.click();
      await expect(section.getByText("Wo soll er wohnen?")).toBeVisible();
    } finally {
      await childContext.close().catch(() => undefined);
      await adultContext.close().catch(() => undefined);
    }
  });

  test("a browser with no family session is told nothing about the replies", async ({
    request,
  }) => {
    const response = await request.get("/api/family/replies");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

/**
 * MCL-75. The loop closing: a child answers the question that came back.
 *
 * This is the sprint goal expressed as a test. Everything before it proves a reply can be
 * written and read; this proves a child can act on it, and that what they send lands in
 * the chain an adult can follow - through the questionId filter that already existed,
 * with no new route behind it.
 */
test.describe("Die Antwort des Kindes", () => {
  test("a child answers the reply, and it lands in the chain", async ({ browser }) => {
    const childContext = await browser.newContext();
    const adultContext = await browser.newContext();

    try {
      const child = await childContext.newPage();
      await signInAsFamily(child);
      await submitIdea(child, "Ein Fisch der fliegt");

      const adult = await adultContext.newPage();
      await signInAsAdmin(adult);
      await adult.goto("/admin");
      const card = adult.locator(".admin-reply").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.getByLabel(/Verstanden/u).fill("Du möchtest einen Fisch, der fliegt.");
      await card.getByLabel(/Eine Frage an dich/u).fill("Wie hoch soll er fliegen?");
      await card.getByRole("button", { name: "Antwort senden" }).click();
      await expect(card.getByText("Du möchtest einen Fisch, der fliegt.")).toBeVisible({
        timeout: 15_000,
      });

      await child.reload();
      const section = child.locator("#antworten");
      await expect(section.getByText("Wie hoch soll er fliegen?")).toBeVisible({ timeout: 15_000 });

      // The way back is revealed, not permanently on screen: three replies should read as
      // three answers, not as three forms.
      await section.getByRole("button", { name: "Antworten" }).first().click();
      const answerField = section.getByLabel("Deine Antwort").first();
      await expect(answerField).toBeVisible();
      await answerField.fill("Über die Wolken");
      await section.getByRole("button", { name: "Antwort speichern" }).first().click();

      // "Meine Ideen" calls it an answer to Papa's question, not an orphan of an earlier
      // one - the failure MCL-75's label branch exists to prevent.
      const mine = child.locator("#meine-ideen");
      await expect(mine.getByText("Über die Wolken")).toBeVisible({ timeout: 15_000 });
      await expect(mine.getByText(/Deine Antwort auf .*Frage/u).first()).toBeVisible();

      expectChildSafe(await section.innerText(), "the reply section after answering");

      await adult.reload();
      // The chain is reachable from the adult's own card, through the existing filter.
      await adult.getByRole("button", { name: /Kette anzeigen/u }).first().click();
      await expect(adult.getByText("Über die Wolken")).toBeVisible({ timeout: 15_000 });
    } finally {
      await childContext.close().catch(() => undefined);
      await adultContext.close().catch(() => undefined);
    }
  });
});
