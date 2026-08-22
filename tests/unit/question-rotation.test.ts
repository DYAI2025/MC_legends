import { describe, expect, it } from "vitest";
import type { QuestionLifecycleSnapshot } from "@/domain/questions/question-lifecycle";
import {
  focusQuestion,
  openQuestions,
  questionById,
  rotateQuestions,
} from "@/content/open-questions";

/**
 * MCL-35. Which question a child is asked, derived from the seeded dataset plus whatever
 * the lifecycle store has recorded since.
 *
 * The three properties this file exists for, none of which a happy path shows:
 *
 * 1. Closing the active question hands the turn to the next one, and the closed one is
 *    still there to be read - archived, never deleted.
 * 2. Reopening does NOT take the turn away from the question a child is currently being
 *    asked. That is the rule a position-only rotation gets wrong, and it gets it wrong
 *    silently: the answer somebody is halfway through typing becomes an answer to a
 *    question the page no longer shows.
 * 3. With nothing open, `active` is `null` rather than a throw. The child surface has a
 *    state for that; an exception would be a blank page.
 */

const [FIRST, SECOND, THIRD] = openQuestions;

function closedAt(sequence: number) {
  return { state: "closed", sequence } as const;
}

function reopenedAt(sequence: number) {
  return { state: "open", sequence } as const;
}

function ids(questions: readonly { id: string }[]): string[] {
  return questions.map((question) => question.id);
}

describe("rotateQuestions", () => {
  it("starts where the seeded dataset says, with nothing recorded", () => {
    const rotation = rotateQuestions({});

    // Pins the one agreement the whole slice rests on: the rotation rule and the
    // dataset's own `focus: true` flag must name the same question, or the running site
    // and every test that reads `focusQuestion()` are describing two different pages.
    expect(rotation.active?.id).toBe(focusQuestion().id);
    expect(rotation.archived).toEqual([]);
    expect(ids(rotation.upcoming)).toEqual(
      openQuestions.filter((question) => question.id !== focusQuestion().id).map((q) => q.id),
    );
  });

  it("hands the turn to the next open question when the active one is closed", () => {
    const rotation = rotateQuestions({ [FIRST.id]: closedAt(1) });

    expect(rotation.active?.id).toBe(SECOND.id);
    // Archived, not gone: the whole point of closing rather than deleting.
    expect(ids(rotation.archived)).toEqual([FIRST.id]);
    expect(ids(rotation.upcoming)).not.toContain(FIRST.id);
    expect(ids(rotation.upcoming)).not.toContain(SECOND.id);
  });

  it("does not let a reopened question take the turn from the active one", () => {
    // A is closed, so B is being asked. Reopening A must put it back in the queue and
    // leave B exactly where it is.
    const snapshot: QuestionLifecycleSnapshot = {
      [FIRST.id]: reopenedAt(2),
    };

    const rotation = rotateQuestions(snapshot);

    expect(rotation.active?.id).toBe(SECOND.id);
    expect(ids(rotation.upcoming)).toContain(FIRST.id);
    expect(ids(rotation.archived)).not.toContain(FIRST.id);
    // And it went to the BACK of the queue rather than to its dataset position.
    expect(rotation.upcoming.at(-1)?.id).toBe(FIRST.id);
  });

  it("gives the turn to a reopened question when nothing else is open", () => {
    const snapshot: QuestionLifecycleSnapshot = Object.fromEntries(
      openQuestions.map((question, index) => [question.id, closedAt(index + 1)]),
    );

    expect(rotateQuestions(snapshot).active).toBeNull();

    const rotation = rotateQuestions({ ...snapshot, [THIRD.id]: reopenedAt(99) });

    expect(rotation.active?.id).toBe(THIRD.id);
    expect(rotation.upcoming).toEqual([]);
    expect(ids(rotation.archived)).not.toContain(THIRD.id);
  });

  it("orders several reopened questions by when each came back", () => {
    const allClosed = Object.fromEntries(
      openQuestions.map((question, index) => [question.id, closedAt(index + 1)]),
    );

    const rotation = rotateQuestions({
      ...allClosed,
      // THIRD came back first, FIRST second. Dataset position would say the opposite,
      // which is exactly the difference this case pins.
      [THIRD.id]: reopenedAt(10),
      [FIRST.id]: reopenedAt(11),
    });

    expect(rotation.active?.id).toBe(THIRD.id);
    expect(ids(rotation.upcoming)).toEqual([FIRST.id]);
  });

  it("leaves nothing to answer once every question is closed", () => {
    const rotation = rotateQuestions(
      Object.fromEntries(openQuestions.map((question, index) => [question.id, closedAt(index + 1)])),
    );

    expect(rotation.active).toBeNull();
    expect(rotation.upcoming).toEqual([]);
    expect(ids(rotation.archived)).toEqual(ids(openQuestions));
  });

  it("ignores a recorded state for a question the dataset no longer holds", () => {
    // An event log outlives the wording it refers to. A question removed from the
    // dataset must not be resurrected by its old events, and must not make the rotation
    // throw either.
    const rotation = rotateQuestions({ "a-question-that-was-deleted": closedAt(1) });

    expect(rotation.active?.id).toBe(focusQuestion().id);
    expect(ids(rotation.archived)).toEqual([]);
  });

  it("never throws for a snapshot that closes everything, unlike the dataset guard", () => {
    const everythingClosed = Object.fromEntries(
      openQuestions.map((question) => [question.id, closedAt(1)]),
    );

    expect(() => rotateQuestions(everythingClosed)).not.toThrow();
    // The source guard is unchanged and still strict: it is about the DATASET being
    // well-formed, which is a different question from "is anything open right now".
    expect(() => focusQuestion([])).toThrow(/found 0/);
  });
});

describe("questionById", () => {
  it("finds a question a stored answer refers to", () => {
    expect(questionById(FIRST.id)?.title).toBe(FIRST.title);
  });

  it("answers null for an id it does not know instead of throwing", () => {
    // The ids it is asked about come from answers stored on a child's own device, which
    // can outlive the question they were written for. A throw here would take the whole
    // list of their answers down with it.
    expect(questionById("not-a-question")).toBeNull();
  });
});
