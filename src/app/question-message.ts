/**
 * MCL-35. Every sentence a child reads about which question is being asked, kept out of
 * the components so it can be checked without rendering React.
 *
 * Four rules these sentences exist to keep:
 *
 * - No admin vocabulary and no lifecycle vocabulary. A child is never told a question was
 *   "closed", "reopened", "archived" or "rotated" - those are decisions adults made about
 *   the project, and to a child the only fact that matters is what they can do now.
 * - No ids, no codes, no technical detail. A question is named by its own wording or not
 *   at all.
 * - "There is nothing to answer right now" and "we cannot tell you what to answer right
 *   now" are DIFFERENT sentences. The first is a finished project, the second is a
 *   temporary fault, and a child who is told the first when the second is true will stop
 *   coming back.
 * - A recording or an answer already made is never described as lost or wrong because the
 *   question moved on. It still belongs to the question it was made for, and the sentence
 *   says so.
 */

const questionUnavailable = {
  title: "Die Frage ist gerade nicht da.",
  // Deliberately says nothing about why, and deliberately does not say "no question is
  // open": we do not know that. What a child can act on is "come back in a bit".
  body: "Wir können gerade nicht nachsehen, welche Frage dran ist. Schau bitte gleich noch einmal vorbei.",
} as const;

const noOpenQuestion = {
  title: "Gerade ist keine Frage offen.",
  // A finished state, not a fault - and an invitation rather than a dead end. The world
  // above stays readable either way, which is why this does not apologise.
  body: "Du hast alle Fragen beantwortet, die gerade dran sind. Bald kommt eine neue dazu.",
} as const;

/** What a child reads where the question and the answer form would be. */
export function questionUnavailableMessage(): { title: string; body: string } {
  return { ...questionUnavailable };
}

/** What a child reads when every question has been answered. */
export function noOpenQuestionMessage(): { title: string; body: string } {
  return { ...noOpenQuestion };
}

/**
 * Which question one stored answer belongs to.
 *
 * By its wording, never by its id. The id is how this application finds the question; it
 * is not a thing a child has any use for, and it is exactly the sort of value that ends
 * up in a screenshot.
 */
export function answerBelongsToMessage(questionTitle: string): string {
  return `Deine Antwort auf: „${questionTitle}“`;
}

/**
 * The same, for an answer whose question the site no longer carries.
 *
 * It happens: an answer lives on a child's own device and can outlive the wording it was
 * written for. Saying "an earlier question" is honest and keeps the answer theirs;
 * printing the id instead would be neither.
 */
export const answerBelongsToEarlierQuestionMessage =
  "Deine Antwort auf eine frühere Frage.";

/**
 * What a child reads when the recording in front of them was made for a question that is
 * no longer the one being asked.
 *
 * It says the recording is still sendable, because it is: the recording is bound to the
 * question it was made for and goes to the project under that question whatever has
 * changed since. Anything else would tell a child to throw away work they already did
 * because an adult pressed a button.
 */
export function recordingBelongsToMessage(questionTitle: string): string {
  return `Diese Aufnahme gehört zur Frage „${questionTitle}“. Du kannst sie trotzdem abschicken.`;
}

/** The same, when the earlier question's wording is no longer on the site. */
export const recordingBelongsToEarlierQuestionMessage =
  "Diese Aufnahme gehört zu einer früheren Frage. Du kannst sie trotzdem abschicken.";
