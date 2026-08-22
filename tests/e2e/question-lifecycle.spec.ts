import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { QuestionBoardPage } from "@/application/questions/question-board-client";
import type { InboxPage } from "@/application/submissions/submission-inbox-reader";
import {
  answerBelongsToMessage,
  noOpenQuestionMessage,
  questionUnavailableMessage,
  recordingBelongsToMessage,
} from "@/app/question-message";
import { avaloriaIdeas } from "@/content/avaloria-content";
import { openQuestions, openQuestionsAbout } from "@/content/open-questions";
import { TEST_ADMIN_ACCESS_CODE } from "../support/admin-access-code";
import { TEST_FAMILY_ACCESS_CODE } from "../support/family-access-code";
import { signInAsAdmin } from "../support/admin-session";
import { signInAsFamily } from "../support/family-session";
import { expectChildSafe } from "../support/child-safe";

/**
 * MCL-35 in a real browser: an adult closes a question, and the child site asks the next
 * one.
 *
 * This file runs on a SERVER OF ITS OWN (see the chromium-lifecycle project in
 * playwright.config.ts). Closing a question changes what every visitor is asked, and two
 * other specs assert the seeded question by name - on the shared server this file would
 * break them at whatever moment the two happened to overlap.
 *
 * One at a time - the chromium-lifecycle project turns `fullyParallel` off - and the
 * lifecycle log is emptied before every test, so each one starts from the SEEDED state
 * and a CI retry starts where the first attempt did.
 *
 * Emptied rather than restored by reopening: reopening is not the inverse of closing, on
 * purpose. A reopened question queues behind the ones that never left, so a "restore"
 * built out of reopens would leave the next test being asked a different question than
 * the dataset seeds - which is correct product behaviour and useless as a starting point.
 *
 * Deliberately NOT `test.describe.configure({ mode: "serial" })`: that would abort every
 * remaining test as soon as one failed, which turns one real failure into nine unknowns.
 * The tests do not depend on each other - each one starts from an empty log - they only
 * need not to run at the same time.
 */

const [FIRST, SECOND, THIRD] = openQuestions;

/**
 * An element the dataset files under the same topic as an open question, so its detail
 * page normally carries the "Dazu ist noch etwas offen" section. Found rather than named,
 * because a hard-coded id would make this test pass vacuously the day the dataset moved
 * that question to another topic.
 */
const IDEA_WITH_A_QUESTION = avaloriaIdeas.find(
  (idea) => openQuestionsAbout(idea.internalCategory).length > 0,
);

const BOARD = "/api/admin/questions";
const ADMIN_INBOX = "/api/admin/inbox/submissions";

/** Synthetic throughout: no real child, no real name, no production text. */
const answerText = "Ein Steinwolf mit zwei Laternen.";

/** A genuine ID3 header: the upload route checks the bytes against the declared type. */
const audioFileFixture = {
  name: "meine-stimme.mp3",
  mimeType: "audio/mpeg",
  buffer: Buffer.from([0x49, 0x44, 0x33, 0x03]),
};

async function readBoard(page: Page): Promise<QuestionBoardPage> {
  const response = await page.request.get(BOARD);
  expect(response.status(), "the board must be readable by a signed-in adult").toBe(200);
  return (await response.json()) as QuestionBoardPage;
}

async function setQuestionState(
  page: Page,
  questionId: string,
  nextState: "open" | "closed",
  expectedState: "open" | "closed",
): Promise<number> {
  const response = await page.request.post(`${BOARD}/${questionId}`, {
    data: { action: nextState === "closed" ? "close" : "reopen", expectedState },
  });
  return response.status();
}

/**
 * The lifecycle server's own log directory. Mirrors AVALORIA_QUESTION_DIR in the
 * chromium-lifecycle webServer entry of playwright.config.ts, and this file is the only
 * thing that touches it - the other projects run against a different server with a
 * different directory.
 *
 * A path duplicated between a config and a test is a path that can drift, so the
 * beforeEach below asserts what the reset achieved rather than assuming it: a wrong path
 * shows up as a non-empty archive on the second test, which fails loudly and points here.
 */
const LIFECYCLE_QUESTION_DIR = ".data/e2e-lifecycle/questions";

/**
 * Empties the log, so every test starts from the state the dataset seeds.
 *
 * Removing the file rather than reopening every closed question, because reopening is
 * NOT the inverse of closing: a reopened question queues behind the ones that never left,
 * so a restore built out of reopens leaves the next test being asked something other than
 * the seeded question. That is correct product behaviour and a useless starting point.
 *
 * The adapter reads the file on every call and treats a missing file as "nothing was ever
 * closed", so this needs no server restart.
 */
async function emptyTheLog(page: Page): Promise<void> {
  await rm(LIFECYCLE_QUESTION_DIR, { recursive: true, force: true });

  const board = await readBoard(page);
  expect(board.history, `the log at ${LIFECYCLE_QUESTION_DIR} was not the one in use`).toEqual(
    [],
  );
  expect(board.questions.every((entry) => entry.state === "open")).toBe(true);
  expect(board.questions.find((entry) => entry.active)?.id).toBe(FIRST.id);
}

test.beforeEach(async ({ page }) => {
  await signInAsAdmin(page);
  await emptyTheLog(page);
});

test.describe("closing a question", () => {
  test("hands the turn to the next question and keeps the closed one traceable", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: FIRST.title })).toBeVisible();

    // Through the real board, with a real click, as an adult actually does it.
    await page.goto("/admin");
    const board = page.getByRole("region", { name: "Offene Fragen" });
    const firstRow = board.getByRole("listitem").filter({ hasText: FIRST.title }).first();
    await expect(firstRow.getByText("Wird gerade gefragt")).toBeVisible();
    await firstRow.getByRole("button", { name: "Frage schließen" }).click();

    // The board corrects itself: the closed question is closed, the next one is being
    // asked, and the close is in the archive under the question's own wording.
    await expect(firstRow.getByText("Geschlossen")).toBeVisible();
    const secondRow = board.getByRole("listitem").filter({ hasText: SECOND.title }).first();
    await expect(secondRow.getByText("Wird gerade gefragt")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Verlauf" }).getByText(FIRST.title),
    ).toBeVisible();

    // And the child is asked the next one, with the closed one gone from both lists.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: SECOND.title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: FIRST.title })).toHaveCount(0);
    await expect(page.locator(".upcoming-questions li", { hasText: FIRST.title })).toHaveCount(
      0,
    );
  });

  test("does not let a reopened question take the turn back", async ({ page }) => {
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(200);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: SECOND.title })).toBeVisible();

    expect(await setQuestionState(page, FIRST.id, "open", "closed")).toBe(200);

    // Still the second question. A child halfway through typing an answer to it must not
    // find the page asking something else because an adult reopened an older question.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: SECOND.title })).toBeVisible();
    // And the reopened one is waiting again, at the back.
    await expect(page.locator(".upcoming-questions li").last()).toHaveText(FIRST.title);
  });

  test("keeps the close in the archive after the question is reopened", async ({ page }) => {
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(200);
    expect(await setQuestionState(page, FIRST.id, "open", "closed")).toBe(200);

    const board = await readBoard(page);
    const history = board.history.filter((entry) => entry.questionId === FIRST.id);

    // Two events, newest first. Reopening appends; it never erases - which is the whole
    // claim "traceably archived" makes.
    expect(history.map((entry) => entry.action)).toEqual(["reopened", "closed"]);
    expect(history[1].title).toBe(FIRST.title);
    expect(board.questions.find((entry) => entry.id === FIRST.id)?.state).toBe("open");
  });

  test("refuses a second close from a board that has not been reloaded", async ({ page }) => {
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(200);

    // The same request again: an adult on a second device, or a stale tab. Refused with
    // a conflict rather than silently writing a second event.
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(409);
    expect(
      (await readBoard(page)).history.filter((entry) => entry.questionId === FIRST.id),
    ).toHaveLength(1);
  });

  test("leaves the child a safe page when every question is closed", async ({ page }) => {
    for (const question of openQuestions) {
      expect(await setQuestionState(page, question.id, "closed", "open")).toBe(200);
    }

    await signInAsFamily(page);
    await page.goto("/");

    const { title, body } = noOpenQuestionMessage();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByText(body)).toBeVisible();
    expectChildSafe(`${title} ${body}`, "the empty question panel");

    // No form and no recorder: there is nothing to answer, so there is nothing inviting
    // an answer. And the world above is still readable.
    await expect(page.getByLabel("Deine Antwort")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Antwort aufnehmen" })).toHaveCount(0);
    await expect(page.locator(".upcoming-questions")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Was möchtest du entdecken?" })).toBeVisible();
  });

  test("gives the turn to a reopened question when nothing else is open", async ({ page }) => {
    for (const question of openQuestions) {
      expect(await setQuestionState(page, question.id, "closed", "open")).toBe(200);
    }

    // Nothing is being asked, and then one question comes back. With no active question
    // to protect, it takes the turn - which is the other half of "reopening must not
    // steal the turn": it must not be inert either.
    expect(await setQuestionState(page, THIRD.id, "open", "closed")).toBe(200);

    await signInAsFamily(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: THIRD.title })).toBeVisible();
    await expect(page.getByLabel("Deine Antwort")).toBeVisible();
  });
});

test.describe("when the lifecycle store cannot be read", () => {
  /**
   * Makes the log unreadable, the way a truncated write or a half-restored backup would.
   *
   * A damaged line rather than a permissions trick, because that is the failure this
   * adapter is built to refuse: it throws rather than skipping the line, precisely so a
   * dropped `closed` event cannot silently put a retired question back in front of a
   * child.
   */
  async function damageTheLog(): Promise<void> {
    await mkdir(LIFECYCLE_QUESTION_DIR, { recursive: true });
    await writeFile(join(LIFECYCLE_QUESTION_DIR, "question-lifecycle.jsonl"), "{not json}\n");
  }

  test("tells the child it cannot say, instead of showing the seeded question", async ({
    page,
  }) => {
    await signInAsFamily(page);
    await damageTheLog();
    await page.goto("/");

    const { title, body } = questionUnavailableMessage();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByText(body)).toBeVisible();
    expectChildSafe(`${title} ${body}`, "the unavailable question panel");

    // The seeded question must NOT be presented as the current one. That fallback keeps
    // every page rendering and is exactly why it is refused: an adult may have retired
    // this question weeks ago, and nothing here can tell.
    await expect(page.getByRole("heading", { level: 2, name: FIRST.title })).toHaveCount(0);
    await expect(page.getByText(SECOND.title)).toHaveCount(0);

    // And no way to write a new answer against a question nobody can vouch for.
    await expect(page.getByLabel("Deine Antwort")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Antwort aufnehmen" })).toHaveCount(0);
    await expect(page.locator(".upcoming-questions")).toHaveCount(0);

    // The world itself is still readable: the failure is about the question, not the site.
    await expect(page.getByRole("heading", { name: "Was möchtest du entdecken?" })).toBeVisible();
  });

  test("says the same on a detail page, and offers no way in from there", async ({ page }) => {
    await signInAsFamily(page);
    await damageTheLog();
    expect(IDEA_WITH_A_QUESTION, "the dataset needs one element with an open question").toBeDefined();
    await page.goto(`/welt/${IDEA_WITH_A_QUESTION?.id}`);

    await expect(
      page.getByRole("heading", { level: 2, name: questionUnavailableMessage().title }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Diese Frage beantworten/u })).toHaveCount(0);
  });

  test("refuses to let an adult act on a state nobody could read", async ({ page }) => {
    await damageTheLog();

    // Fail closed, both ways: the board cannot be read and nothing can be changed. An
    // adult closing a question from a guess is the dangerous direction.
    expect((await page.request.get(BOARD)).status()).toBe(503);
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(503);
  });
});

test.describe("who may close a question", () => {
  /** A request context with no cookies at all - not the page's. */
  async function anonymousChange(request: APIRequestContext): Promise<number> {
    const response = await request.post(`${BOARD}/${FIRST.id}`, {
      data: { action: "close", expectedState: "open" },
    });
    return response.status();
  }

  test("refuses a caller with no session", async ({ page, request }) => {
    expect(await anonymousChange(request)).toBe(401);
    // Nothing happened: the seeded question is still the one being asked.
    expect((await readBoard(page)).questions.find((entry) => entry.id === FIRST.id)?.state).toBe(
      "open",
    );
  });

  test("refuses a real family session, which is the code the children hold", async ({
    page,
    request,
  }) => {
    // A genuine sign-in through the real endpoint, so this is not a test about a
    // malformed cookie: it is a test about the right cookie for the wrong door.
    const signIn = await request.post("/api/family/session", {
      data: { accessCode: TEST_FAMILY_ACCESS_CODE },
    });
    expect(signIn.status()).toBe(200);

    expect(await anonymousChange(request)).toBe(401);
    expect((await readBoard(page)).questions.find((entry) => entry.id === FIRST.id)?.state).toBe(
      "open",
    );
  });

  test("gives a child no way to reach the board at all", async ({ page }) => {
    await signInAsFamily(page);
    await page.goto("/");

    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const word of ["frage schließen", "wieder öffnen", "verlauf", TEST_ADMIN_ACCESS_CODE]) {
      expect(body, `the child page must not carry ${word}`).not.toContain(word.toLowerCase());
    }
  });
});

test.describe("an answer keeps the question it was written for", () => {
  test("shows a typed answer under its own question after the question closes", async ({
    page,
  }) => {
    await signInAsFamily(page);
    await page.goto("/");

    await page.getByLabel("Deine Antwort").fill(answerText);
    await page.getByRole("button", { name: "Antwort speichern" }).click();
    await expect(page.getByText("Deine Antwort ist im Projekt angekommen.")).toBeVisible();

    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(200);
    await page.goto("/");

    // The page is asking the next question now - and the answer already given still says
    // which question it belongs to, in that question's own words.
    await expect(page.getByRole("heading", { level: 2, name: SECOND.title })).toBeVisible();
    const myIdeas = page.locator(".my-idea").filter({ hasText: answerText });
    await expect(myIdeas.getByText(answerBelongsToMessage(FIRST.title))).toBeVisible();
    // Never the id, on any child-facing surface.
    expect(await page.locator("body").innerText()).not.toContain(FIRST.id);

    // And the project holds it under the question it was written for, not under the one
    // that replaced it.
    const stored = await page.request.get(`${ADMIN_INBOX}?questionId=${FIRST.id}`);
    expect(stored.status()).toBe(200);
    const page1 = (await stored.json()) as InboxPage;
    expect(page1.entries.some((entry) => entry.questionId === FIRST.id)).toBe(true);

    const other = await page.request.get(`${ADMIN_INBOX}?questionId=${SECOND.id}`);
    expect(((await other.json()) as InboxPage).total).toBe(0);
  });

  test("sends a recording to the question it was made for, after a rotation", async ({
    page,
  }) => {
    await signInAsFamily(page);
    await page.goto("/");

    // Counted before anything is sent, so a CI retry - which reuses this server's inbox -
    // measures the delta this run caused rather than everything that ever landed.
    const audioUnderFirstBefore = (
      (await (
        await page.request.get(`${ADMIN_INBOX}?questionId=${FIRST.id}&kind=audio`)
      ).json()) as InboxPage
    ).total;

    // Made while the first question is the one being asked.
    await expect(page.getByRole("heading", { level: 2, name: FIRST.title })).toBeVisible();
    const area = page.getByRole("region", { name: "Antwort aufnehmen" });
    await page.setInputFiles("#audio-file", audioFileFixture);
    await expect(page.locator(".audio-answer-player")).toBeVisible();

    // An adult closes that question while the child is still looking at the recording.
    expect(await setQuestionState(page, FIRST.id, "closed", "open")).toBe(200);

    // A soft navigation the child makes all the time - picking a topic - re-renders the
    // page from the server without unmounting the recorder. The page now asks the next
    // question; the recording is still the one they made.
    await page.getByRole("button", { name: "Wesen & Figuren" }).click();
    await expect(page).toHaveURL(/thema=/u);
    await expect(page.getByRole("heading", { level: 2, name: SECOND.title })).toBeVisible();
    await expect(page.locator(".audio-answer-player")).toBeVisible();

    // Said out loud, in the question's own words, and the send button is still offered.
    const notice = recordingBelongsToMessage(FIRST.title);
    await expect(area.getByText(notice)).toBeVisible();
    expectChildSafe(notice, "the recording-belongs notice");

    await area.getByRole("button", { name: "Aufnahme abschicken" }).click();
    await expect(area.getByText("Deine Aufnahme ist im Projekt angekommen.")).toBeVisible();

    // The one that matters: the project holds it under the question it was recorded for.
    const underFirst = (await (
      await page.request.get(`${ADMIN_INBOX}?questionId=${FIRST.id}&kind=audio`)
    ).json()) as InboxPage;
    expect(underFirst.total).toBe(audioUnderFirstBefore + 1);

    // And nothing at all under the question that replaced it. This is the assertion the
    // whole binding exists for: without it the recording would be filed under whatever
    // the page happened to be asking when the child pressed send.
    const underSecond = (await (
      await page.request.get(`${ADMIN_INBOX}?questionId=${SECOND.id}&kind=audio`)
    ).json()) as InboxPage;
    expect(underSecond.total).toBe(0);
  });
});
