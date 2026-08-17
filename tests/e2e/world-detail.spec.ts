import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  avaloriaIdeas,
  categorySlugFor,
  ideaAnchorId,
  ideaById,
  relatedIdeas,
  type AvaloriaIdea,
  type CategoryFilter,
} from "@/content/avaloria-content";
import {
  childStatusFor,
  childStatusPresentationFor,
  childTopicLabelFor,
} from "@/content/content-source";
import { focusQuestion, openQuestionsAbout } from "@/content/open-questions";
import { expectChildSafe } from "../support/child-safe";

/**
 * MCL-47. Reading the world needs no family session - only writing does - so nothing
 * here signs in. That is deliberate: if a test needed a session to open a tile, the tile
 * would be behind the gate, which is not what the slice built.
 */

/**
 * The fixtures are read from the dataset rather than retyped, so a content change moves
 * the tests with it instead of leaving them asserting yesterday's world. Each one is
 * picked by the property the test is actually about.
 */
function ideaWithTruth(truthStatus: AvaloriaIdea["truthStatus"]): AvaloriaIdea {
  const found = avaloriaIdeas.find((idea) => idea.truthStatus === truthStatus);
  if (found === undefined) throw new Error(`no ${truthStatus} idea in the dataset`);
  return found;
}

const statedIdea = ideaWithTruth("STATED");
const tentativeIdea = ideaWithTruth("TENTATIVE");
const openIdea = ideaWithTruth("OPEN");
const ambiguousIdea = ideaWithTruth("AMBIGUOUS");

/** A category with more than one card, so "the grid is filtered" can mean something. */
const filterUnderTest: CategoryFilter = "Geschichte & Welt";
const filteredIdeas = avaloriaIdeas.filter((idea) => idea.childCategory === filterUnderTest);

function cardFor(page: Page, idea: AvaloriaIdea): Locator {
  return page.locator(`#${ideaAnchorId(idea.id)}`);
}

function detailTitle(page: Page, idea: AvaloriaIdea): Locator {
  return page.getByRole("heading", { level: 1, name: idea.title, exact: true });
}

function statusLabelOf(idea: AvaloriaIdea): string {
  return childStatusPresentationFor(childStatusFor(idea.truthStatus)).label;
}

/** Longest transition on an element, in seconds. */
async function settleSeconds(locator: Locator): Promise<number> {
  const durations = await locator.evaluate((element) =>
    getComputedStyle(element)
      .transitionDuration.split(",")
      .map((value) => Number.parseFloat(value)),
  );
  return Math.max(...durations);
}

async function arrowShift(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).transform);
}

/**
 * Everything the detail page says about the element being read - its own header and its
 * own fact list - and nothing it says about its neighbours. The related cards carry the
 * neighbours' status badges on purpose, exactly as the overview grid does, so a whole-body
 * assertion about a status label would be reading someone else's badge.
 */
async function ownClaimText(page: Page): Promise<string> {
  const head = await page.locator(".detail-head").innerText();
  const facts = await page.locator(".detail-facts").innerText();
  return `${head}\n${facts}`;
}

test.describe("A - mouse", () => {
  test("clicking a tile opens that tile's own page", async ({ page }) => {
    await page.goto("/");
    const card = cardFor(page, statedIdea);
    await expect(card).toBeVisible();

    await card.click();

    await expect(page).toHaveURL(new RegExp(`/welt/${statedIdea.id}(\\?|$)`));
    await expect(detailTitle(page, statedIdea)).toBeVisible();
    await expect(page.getByText(statedIdea.summary, { exact: true })).toBeVisible();
    // The right tile, not merely a tile: a second card's title must not be the heading.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test("clicking anywhere in the tile counts, not only on the words", async ({ page }) => {
    await page.goto("/");
    const card = cardFor(page, tentativeIdea);
    // page.mouse works in viewport coordinates, so the card has to be on screen before
    // its box means anything.
    await card.scrollIntoViewIfNeeded();

    // The top-right corner: inside the card, outside every text run in it. A card whose
    // link only wrapped the heading would leave this click on dead pixels.
    const box = await card.boundingBox();
    expect(box, "the card has to be laid out to be clicked").not.toBeNull();
    await page.mouse.click(box!.x + box!.width - 6, box!.y + 6);

    await expect(detailTitle(page, tentativeIdea)).toBeVisible();
  });
});

test.describe("B - keyboard", () => {
  test("a tile is reachable by Tab, shows focus and opens with Enter", async ({ page }) => {
    await page.goto("/");

    // Tab forward from the last filter chip - the element right before the grid. Calling
    // focus() on the card instead would prove only that focus() works, not that a child
    // tabbing through the page ever arrives there.
    const lastChip = page.getByRole("button", { name: "Offene Ideen" });
    await lastChip.focus();
    await page.keyboard.press("Tab");

    const firstCard = cardFor(page, avaloriaIdeas[0]);
    await expect(firstCard).toBeFocused();

    // A real, visible focus ring - not merely "some element is focused".
    const outline = await firstCard.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
    });
    expect(outline.style).not.toBe("none");
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Enter");
    await expect(detailTitle(page, avaloriaIdeas[0])).toBeVisible();
  });

  test("every tile in the grid is in the tab order", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Offene Ideen" }).focus();

    // Walk the whole grid with the keyboard alone and collect where focus lands.
    const reached: string[] = [];
    for (let step = 0; step < avaloriaIdeas.length; step += 1) {
      await page.keyboard.press("Tab");
      reached.push(await page.evaluate(() => document.activeElement?.id ?? ""));
    }

    expect(reached).toEqual(avaloriaIdeas.map((idea) => ideaAnchorId(idea.id)));
  });
});

test.describe("C - small screens", () => {
  // hasTouch, not just a narrow window: without it `tap()` is refused and the test would
  // be proving the mouse works at 390px, which is not what the criterion asks.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tile opens and reads on a phone", async ({ page }) => {
    await page.goto("/");
    const card = cardFor(page, openIdea);
    await card.scrollIntoViewIfNeeded();

    // A touch target has to be big enough to hit with a thumb.
    const box = await card.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);

    await card.tap();

    await expect(detailTitle(page, openIdea)).toBeVisible();
    await expect(detailTitle(page, openIdea)).toBeInViewport();
    await expect(page.getByText(openIdea.summary, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Zurück zu den Ideen/ }).first()).toBeVisible();

    // Nothing runs off the side of a 390px screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("D - back navigation", () => {
  const ideaInFilter = filteredIdeas[1];
  /**
   * The card that is furthest down the filtered grid, so "the child is back where they
   * were" has to mean scrolling and cannot be satisfied by a card that happened to be on
   * screen anyway. Picked by position rather than by name: whichever element the dataset
   * puts last is the one the test wants, and the precondition below refuses to run if
   * that element is on screen at the top of the page after all.
   */
  const deepIdeaInFilter = filteredIdeas[filteredIdeas.length - 1];

  test("the page's own back link returns the topic, the card and the keyboard", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: filterUnderTest, pressed: false }).click();
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);

    await cardFor(page, ideaInFilter).click();
    await expect(detailTitle(page, ideaInFilter)).toBeVisible();
    // The address carries the topic the child came from, which is what makes the way
    // back a fact rather than a guess.
    await expect(page).toHaveURL(new RegExp(`thema=${categorySlugFor(filterUnderTest)}`));

    await page.getByRole("link", { name: /Zurück zu den Ideen/ }).first().click();

    // Same topic, same filtered grid.
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);
    // Same card, on screen and holding the keyboard.
    const card = cardFor(page, ideaInFilter);
    await expect(card).toBeInViewport();
    await expect(card).toBeFocused();
  });

  /**
   * The same promise for a card the child had to scroll down to reach.
   *
   * The case above cannot make that promise: its card sits near the top of the filtered
   * grid and is on screen whether anything scrolled or not, so it passes without the way
   * back ever having moved the page. This one starts from a card that is genuinely out of
   * sight, which is what the deployed defect was reported against.
   *
   * Honest about what it does and does not catch: this case passed at 7469bb2, before the
   * repair, because it waits and the restoring scroll did eventually arrive - roughly
   * 600ms later, animated. The case below is the one that fails there. Both are kept: this
   * one pins that a deep card is restored at all, that one pins that it is restored in a
   * way a child cannot destroy.
   *
   * No pixel in this test is asserted. The precondition proves the card is genuinely off
   * screen for this viewport, and the assertions afterwards are the four things a child
   * would notice: their topic, their card, their keyboard, and being able to see it.
   */
  test("the back link brings a card from far down the grid back on screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: filterUnderTest, pressed: false }).click();
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);

    /**
     * The precondition the whole case rests on, checked in the state the way back
     * actually lands in: the top of the overview. Reaching a chip scrolls the page - the
     * grid begins below the hero - so the top is restored first, and from there this card
     * has to be out of sight. If a content or layout change ever brought it on screen
     * here, the case fails loudly instead of passing while proving nothing.
     */
    await page.evaluate(() => window.scrollTo(0, 0));
    const card = cardFor(page, deepIdeaInFilter);
    await expect(
      card,
      "the fixture has to be a card the child cannot see from the top of the overview",
    ).not.toBeInViewport();

    await card.click();
    await expect(detailTitle(page, deepIdeaInFilter)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`thema=${categorySlugFor(filterUnderTest)}`));

    await page.getByRole("link", { name: /Zurück zu den Ideen/ }).first().click();

    // Their topic and their grid.
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);
    // Their card: addressed, holding the keyboard, and where they can see it. Focus
    // without sight is the production defect this case pins.
    await expect(page).toHaveURL(new RegExp(`#${ideaAnchorId(deepIdeaInFilter.id)}$`));
    await expect(cardFor(page, deepIdeaInFilter)).toBeFocused();
    await expect(cardFor(page, deepIdeaInFilter)).toBeInViewport();
  });

  /**
   * The same way back, for the child who does not wait.
   *
   * Restoring the card by moving the page is not one event but half a second of travel:
   * `html { scroll-behavior: smooth }` turns the jump back down to the grid into an
   * animation, and an animated scroll is cancelled by the next scroll input. Handing the
   * keyboard back to the child and then needing them to keep their hands still is not a
   * promise this page can keep - restoring focus is precisely an invitation to press a
   * key.
   *
   * Measured on the production build at 7469bb2: pressing one arrow key as focus landed
   * left the page at scrollY 40 with the card's top edge at 1520 in a 720px viewport,
   * still focused and still out of sight. That reproduces what the deployed build was
   * reported to do - scrollY 61, card top 1493, document.activeElement.id
   * idee-world-kings-castle. Left alone, the same run settled at scrollY 1308 about 600ms
   * later, which is why every test written before this one passed.
   */
  test("a child who uses the keyboard on arrival keeps their card", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: filterUnderTest, pressed: false }).click();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);

    await page.evaluate(() => window.scrollTo(0, 0));
    const card = cardFor(page, deepIdeaInFilter);
    await expect(
      card,
      "the fixture has to be a card the child cannot see from the top of the overview",
    ).not.toBeInViewport();

    await card.click();
    await expect(detailTitle(page, deepIdeaInFilter)).toBeVisible();

    await page.getByRole("link", { name: /Zurück zu den Ideen/ }).first().click();

    // The moment the card has the keyboard, the child uses it. Waiting on focus rather
    // than on a delay keeps this a fact about the page and not about how fast the
    // machine running it happens to be.
    await page.waitForFunction(
      (anchorId) => document.activeElement?.id === anchorId,
      ideaAnchorId(deepIdeaInFilter.id),
    );
    await page.keyboard.press("ArrowDown");

    // Their topic, their card, their keyboard - and their card still on screen.
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);
    await expect(cardFor(page, deepIdeaInFilter)).toBeFocused();
    await expect(cardFor(page, deepIdeaInFilter)).toBeInViewport();
  });

  test("the browser's own back button returns the topic too", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: filterUnderTest, pressed: false }).click();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);

    await cardFor(page, ideaInFilter).click();
    await expect(detailTitle(page, ideaInFilter)).toBeVisible();

    await page.goBack();

    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(filteredIdeas.length);
    await expect(cardFor(page, ideaInFilter)).toBeVisible();
  });

  test("choosing three topics leaves one step between the child and the way back", async ({
    page,
  }) => {
    await page.goto("/");
    const entriesBefore = await page.evaluate(() => history.length);

    for (const category of ["Wesen & Figuren", "Quests & Abenteuer", filterUnderTest] as const) {
      await page.getByRole("button", { name: category, pressed: false }).click();
      await expect(page.getByRole("button", { name: category, pressed: true })).toBeVisible();
    }

    // The measurement this case exists for. Trying topics is browsing, not travelling:
    // it must leave nothing behind for the back button to walk through. Measured with
    // router.push instead of router.replace, this is entriesBefore + 3, and a child who
    // tried three topics has to press back four times to leave the page.
    expect(
      await page.evaluate(() => history.length),
      "choosing a topic must not add a history entry",
    ).toBe(entriesBefore);

    // And one step really is enough to get back from the tile they then opened.
    await cardFor(page, ideaInFilter).click();
    await expect(detailTitle(page, ideaInFilter)).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("button", { name: filterUnderTest, pressed: true })).toBeVisible();
  });

  test("an address for an idea that does not exist is not quietly redirected", async ({ page }) => {
    const response = await page.goto("/welt/gibt-es-nicht");
    expect(response?.status()).toBe(404);
    await expect(page).toHaveURL(/\/welt\/gibt-es-nicht$/);
  });

  test("an unknown topic in the address shows the whole world instead of nothing", async ({
    page,
  }) => {
    await page.goto("/?thema=diesen-filter-gibt-es-nicht");
    await expect(page.getByRole("button", { name: "Alle Ideen", pressed: true })).toBeVisible();
    await expect(page.locator(".idea-card")).toHaveCount(avaloriaIdeas.length);
  });
});

test.describe("E - status truth", () => {
  test("a settled idea and an idea-stage entry read differently", async ({ page }) => {
    // The two labels come from the mapping, not from retyped strings: if the mapping
    // changed, this test would follow it rather than pass against a stale literal.
    expect(statusLabelOf(statedIdea)).not.toBe(statusLabelOf(tentativeIdea));

    await page.goto(`/welt/${statedIdea.id}`);
    await expect(page.locator(".detail-status")).toHaveText(
      new RegExp(statusLabelOf(statedIdea)),
    );
    expect(await ownClaimText(page)).not.toContain(statusLabelOf(tentativeIdea));

    await page.goto(`/welt/${tentativeIdea.id}`);
    await expect(page.locator(".detail-status")).toHaveText(
      new RegExp(statusLabelOf(tentativeIdea)),
    );
    expect(await ownClaimText(page)).not.toContain(statusLabelOf(statedIdea));
  });

  test("the page carries the element's own topic and sentence, not a neighbour's", async ({
    page,
  }) => {
    await page.goto(`/welt/${statedIdea.id}`);
    await expect(page.getByText(childTopicLabelFor(statedIdea.internalCategory))).toHaveCount(1);
    await expect(page.getByText(statedIdea.summary, { exact: true })).toBeVisible();

    const other = avaloriaIdeas.find(
      (idea) => idea.internalCategory !== statedIdea.internalCategory,
    )!;
    await expect(page.locator("body")).not.toContainText(other.summary);
  });

  test("the other ideas of the same topic are offered, and no others", async ({ page }) => {
    const neighbours = relatedIdeas(tentativeIdea);
    expect(neighbours.length, "fixture needs an idea that has neighbours").toBeGreaterThan(0);

    await page.goto(`/welt/${tentativeIdea.id}`);
    const related = page.locator(".detail-related-card");
    await expect(related).toHaveCount(neighbours.length);
    for (const neighbour of neighbours) {
      await expect(related.filter({ hasText: neighbour.title })).toHaveCount(1);
    }
    // A neighbour link really goes to that neighbour's page.
    await related.filter({ hasText: neighbours[0].title }).click();
    await expect(detailTitle(page, neighbours[0])).toBeVisible();
  });
});

test.describe("F - open content stays open", () => {
  for (const idea of [openIdea, ambiguousIdea]) {
    test(`an undecided idea (${idea.truthStatus}) is never presented as settled`, async ({
      page,
    }) => {
      const presentation = childStatusPresentationFor(childStatusFor(idea.truthStatus));
      const settled = childStatusPresentationFor("in-world");
      expect(presentation.id, "fixture must not already be settled").not.toBe("in-world");

      await page.goto(`/welt/${idea.id}`);

      await expect(page.locator(".detail-status")).toHaveText(new RegExp(presentation.label));
      // Said out loud, not only signalled by a colour a child has to remember.
      await expect(page.getByText(presentation.explanation).first()).toBeVisible();
      // The one assertion this case exists for: what the page claims about THIS element
      // never reads as settled...
      expect(await ownClaimText(page)).not.toContain(settled.label);
      // ...and the settled wording appears nowhere on the page at all, not even borrowed
      // from a neighbour, because only the badge label travels to a related card.
      await expect(page.locator("body")).not.toContainText(settled.explanation);
    });
  }

  test("an open question that belongs to the element is shown as still open", async ({ page }) => {
    const questions = openQuestionsAbout(openIdea.internalCategory);
    expect(questions.length, "fixture needs an idea with an open question").toBeGreaterThan(0);

    await page.goto(`/welt/${openIdea.id}`);
    await expect(page.getByRole("heading", { name: "Dazu ist noch etwas offen" })).toBeVisible();
    for (const question of questions) {
      await expect(page.getByText(question.title, { exact: true })).toBeVisible();
    }
  });

  test("nothing is invented for an element the project asks no question about", async ({ page }) => {
    const withoutQuestion = avaloriaIdeas.find(
      (idea) => openQuestionsAbout(idea.internalCategory).length === 0,
    );
    expect(withoutQuestion, "fixture needs an idea with no question").toBeDefined();

    await page.goto(`/welt/${withoutQuestion!.id}`);
    await expect(detailTitle(page, withoutQuestion!)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dazu ist noch etwas offen" })).toHaveCount(0);
  });

  test("only the question a child can answer right now offers the way to answer it", async ({
    page,
  }) => {
    const focus = focusQuestion();
    const others = openQuestionsAbout(focus.internalCategory).filter(
      (question) => question.id !== focus.id,
    );
    const ideaWithFocusQuestion = avaloriaIdeas.find(
      (idea) => idea.internalCategory === focus.internalCategory,
    )!;

    await page.goto(`/welt/${ideaWithFocusQuestion.id}`);
    const answer = page.getByRole("link", { name: /Diese Frage beantworten/ });
    await expect(answer).toHaveCount(1);

    // Every other question of that topic says it is not its turn yet.
    await expect(page.locator(".detail-question-later")).toHaveCount(others.length);

    await answer.click();
    await expect(page.getByRole("heading", { level: 2, name: focus.title })).toBeVisible();
  });
});

test.describe("G - reduced motion", () => {
  test("the hover affordance really animates by default", async ({ page }) => {
    await page.goto("/");
    const card = cardFor(page, statedIdea);
    const arrow = card.locator(".idea-more-arrow");

    expect(await settleSeconds(arrow)).toBeGreaterThan(0.1);
    expect(await settleSeconds(card)).toBeGreaterThan(0.1);

    const atRest = await arrowShift(arrow);
    await card.hover();
    await expect
      .poll(async () => arrowShift(arrow), { timeout: 2000 })
      .not.toBe(atRest);
  });

  test.describe("with the setting on", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the same affordance stops animating and still works", async ({ page }) => {
      await page.goto("/");
      const card = cardFor(page, statedIdea);
      const arrow = card.locator(".idea-more-arrow");

      expect(await settleSeconds(arrow)).toBeLessThan(0.001);
      expect(await settleSeconds(card)).toBeLessThan(0.001);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
      ).toBe("auto");

      // The cue is still there and the tile still opens - the setting removes movement,
      // not the affordance.
      await expect(card.getByText("Mehr entdecken")).toBeVisible();
      await card.click();
      await expect(detailTitle(page, statedIdea)).toBeVisible();

      const relatedCard = page.locator(".detail-related-card").first();
      if ((await relatedCard.count()) > 0) {
        expect(await settleSeconds(relatedCard)).toBeLessThan(0.001);
      }
    });
  });
});

test.describe("H - accessibility and child-safe language", () => {
  test("the tile is a link with the idea's name as its accessible name", async ({ page }) => {
    await page.goto("/");
    const card = cardFor(page, statedIdea);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("href", new RegExp(`/welt/${statedIdea.id}`));
    await expect(card).toHaveRole("link");
    // Semantic activation, not a div wearing a role.
    expect(await card.evaluate((element) => element.tagName)).toBe("A");
    // A child using a screen reader hears which idea this is, not "link".
    await expect(card).toHaveAccessibleName(new RegExp(statedIdea.title));
  });

  test("the detail page has one first-level heading and a labelled picture", async ({ page }) => {
    await page.goto(`/welt/${statedIdea.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    const emblem = page.getByRole("img", { name: new RegExp(statedIdea.title) });
    await expect(emblem).toHaveCount(1);
    // The picture is honest about being a placeholder, exactly as the hero art is.
    await expect(page.getByText("Konzeptbild · noch nicht fest")).toBeVisible();
  });

  test("the whole detail page keeps to child language and names no franchise", async ({ page }) => {
    for (const idea of avaloriaIdeas) {
      await page.goto(`/welt/${idea.id}`);
      const visible = await page.locator("body").innerText();

      // Guard against a locator that reads an empty page: the title has to be in the
      // text this assertion checks, otherwise it proves nothing.
      expect(visible, idea.id).toContain(idea.title);
      expectChildSafe(visible, `the detail page for ${idea.id}`);

      const lowered = visible.toLowerCase();
      for (const forbidden of ["harry potter", "hogwarts", "eule", "wachssiegel", "zauberschule"]) {
        expect(lowered, `${idea.id} must not name ${forbidden}`).not.toContain(forbidden);
      }
      // No source references, no issue keys, no project bookkeeping.
      expect(visible, idea.id).not.toMatch(/MCL-\d+/);
      expect(visible, idea.id).not.toContain(idea.source.note);
    }
  });

  test("the way back is reachable from the keyboard on the detail page", async ({ page }) => {
    await page.goto(`/welt/${statedIdea.id}`);

    const back = page.getByRole("link", { name: /Zurück zu den Ideen/ }).first();
    await back.focus();
    await expect(back).toBeFocused();

    const outline = await back.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe("none");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: /Avaloria/ })).toBeVisible();
    await expect(cardFor(page, statedIdea)).toBeFocused();
  });

  test("every idea in the dataset really has a page", async ({ page }) => {
    // No sampling: a tile a child can see and cannot open is the bug this slice fixes.
    for (const idea of avaloriaIdeas) {
      const response = await page.goto(`/welt/${idea.id}`);
      expect(response?.status(), idea.id).toBe(200);
      await expect(detailTitle(page, idea)).toBeVisible();
      expect(ideaById(idea.id)?.title).toBe(idea.title);
    }
  });
});
