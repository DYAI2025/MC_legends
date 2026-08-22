import { describe, expect, it } from "vitest";
import {
  answerBelongsToEarlierQuestionMessage,
  answerBelongsToMessage,
  noOpenQuestionMessage,
  questionUnavailableMessage,
  recordingBelongsToEarlierQuestionMessage,
  recordingBelongsToMessage,
} from "@/app/question-message";
import { openQuestions } from "@/content/open-questions";
import { childUnsafeMentions, expectChildSafe } from "../support/child-safe";

/**
 * MCL-35's child-facing wording.
 *
 * Two rules that a rendering test would not catch, because they are about what the words
 * MEAN rather than about whether they appear:
 *
 * 1. No lifecycle or admin vocabulary reaches a child. "Geschlossen", "archiviert",
 *    "Verwaltung" and friends are decisions adults made about the project.
 * 2. "Nothing to answer" and "we cannot tell you what to answer" are different sentences.
 *    Telling a child the first when the second is true teaches them to stop coming back.
 */

/** Every string this module can put in front of a child, with a title of its own. */
const everySentence = [
  ...Object.values(questionUnavailableMessage()),
  ...Object.values(noOpenQuestionMessage()),
  answerBelongsToMessage(openQuestions[0].title),
  answerBelongsToEarlierQuestionMessage,
  recordingBelongsToMessage(openQuestions[0].title),
  recordingBelongsToEarlierQuestionMessage,
];

describe("question messages", () => {
  it("says nothing technical or project-management shaped", () => {
    for (const sentence of everySentence) {
      expectChildSafe(sentence, "question message");
    }
  });

  it("never uses the words adults use about a question", () => {
    // The vocabulary of THIS slice specifically, which the shared child-safe list has no
    // reason to know about: a child is not told a question was closed, reopened,
    // archived or rotated.
    const adultWords = [
      "geschlossen",
      "schließen",
      "geöffnet",
      "archiv",
      "verwaltung",
      "rotation",
      "status",
      "lifecycle",
    ];

    for (const sentence of everySentence) {
      for (const word of adultWords) {
        expect(sentence.toLowerCase(), `${word} in ${JSON.stringify(sentence)}`).not.toContain(
          word,
        );
      }
    }
  });

  it("keeps a temporary fault apart from a finished set of questions", () => {
    const unavailable = questionUnavailableMessage();
    const none = noOpenQuestionMessage();

    expect(unavailable.title).not.toBe(none.title);
    expect(unavailable.body).not.toBe(none.body);
    // The fault invites a child back soon; the finished state does not pretend anything
    // is broken.
    expect(unavailable.body).toMatch(/gleich|später|noch einmal/u);
    expect(none.body).not.toMatch(/nicht erreichbar|kaputt|Fehler/u);
  });

  it("names a question by its wording, never by its id", () => {
    const [question] = openQuestions;

    expect(answerBelongsToMessage(question.title)).toContain(question.title);
    expect(answerBelongsToMessage(question.title)).not.toContain(question.id);
    expect(recordingBelongsToMessage(question.title)).not.toContain(question.id);
  });

  it("tells a child a recording made for an earlier question can still be sent", () => {
    // The product rule this sentence carries: rotation changes what is offered, never
    // what a child has already made. Anything that read as "record it again" would throw
    // their work away because an adult pressed a button.
    for (const sentence of [
      recordingBelongsToMessage(openQuestions[0].title),
      recordingBelongsToEarlierQuestionMessage,
    ]) {
      expect(sentence).toContain("trotzdem abschicken");
    }
  });

  it("stays safe when the question wording itself is interpolated", () => {
    // The wording comes from the dataset, which is already checked - so this is a guard
    // against the sentence FRAME hiding an unsafe word behind a placeholder, not against
    // the dataset.
    for (const question of openQuestions) {
      expect(childUnsafeMentions(answerBelongsToMessage(question.title))).toEqual([]);
      expect(childUnsafeMentions(recordingBelongsToMessage(question.title))).toEqual([]);
    }
  });
});
