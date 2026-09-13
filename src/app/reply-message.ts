import type { ComposeReplyRefusal } from "@/application/replies/compose-reply";

/**
 * MCL-74. Every sentence about a reply, kept out of the components so it can be checked
 * without rendering React.
 *
 * Two audiences and two vocabularies, in one file because they are two halves of one
 * feature and drift apart when they are two files:
 *
 * - what a CHILD reads: German, no ids, no status words, no promise about when anything
 *   will happen. Nothing here says "bald", "gleich" or "in Kürze" - the product makes no
 *   latency promise it can keep, and a child who is told "gleich" and waits a day has
 *   been lied to by the interface rather than let down by a person.
 * - what an ADULT reads when a reply is refused: German, concrete, and about the text
 *   they just typed. A refusal an adult cannot act on is a form that appears broken.
 */

/**
 * Who the reply is from, as a child reads it.
 *
 * A constant rather than a value from the data, because the family MVP has exactly one
 * adult writing replies and inventing a per-reply author would be a field nobody fills
 * in truthfully. MCL-41 decides the public-facing name before any public release; until
 * then this is the honest label for this household.
 */
export const FAMILY_REPLIER_LABEL = "Papa";

/** The lead-in above what was understood. */
export function replyUnderstoodLead(): string {
  return `${FAMILY_REPLIER_LABEL} hat verstanden:`;
}

/** The lead-in above the one question. */
export function replyQuestionLead(): string {
  return "Eine Frage an dich:";
}

/**
 * The pill on a reply card.
 *
 * Deliberately built from the idea vocabulary and never from the legend's "Schon dabei":
 * an answered idea is still an idea. A reply is somebody having read it, not the project
 * having adopted it, and a card that implied otherwise would make the status badges
 * fakeable by the one person the child trusts most.
 */
export function replyStatusPill(): string {
  return `Eine Idee - ${FAMILY_REPLIER_LABEL} hat geantwortet`;
}

/**
 * What stands where the replies would be when there are none.
 *
 * Present tense and no timescale. "Noch keine Antwort" is a fact; anything about when one
 * will come would be a promise this page cannot keep.
 */
export function replyEmptyMessage(): string {
  return `Noch keine Antwort. ${FAMILY_REPLIER_LABEL} schaut sich deine Ideen an.`;
}

/** What a card says while it is still looking. Static text, never a spinner. */
export function replyLoadingMessage(): string {
  return "Ich schaue nach …";
}

/**
 * How a card names the idea it answers when that idea was spoken.
 *
 * A recording has no text to quote, so the card offers the day instead. Nothing is
 * transcribed or guessed at: what a child said out loud stays what they said out loud.
 */
export function replyForSpokenIdea(createdAt: string): string {
  const day = new Date(createdAt).toLocaleDateString("de-DE", {
    day: "numeric",
    month: "long",
  });
  return `Zu deiner gesprochenen Idee vom ${day}.`;
}

/** How a card names the idea it answers when that idea was typed. */
export function replyForWrittenIdea(): string {
  return "Zu deiner Idee:";
}

/** The button that reads a card out loud. */
export function replyReadAloudLabel(): string {
  return "Vorlesen";
}

/** The heading of the child's reply section. */
export function replySectionHeading(): string {
  return "Antworten";
}

/** The link from an idea in "Meine Ideen" down to its reply. */
export function replyJumpLabel(): string {
  return `${FAMILY_REPLIER_LABEL} hat geantwortet`;
}

/**
 * What an ADULT is told when a reply was refused.
 *
 * A total table: a new refusal reason is a compile error here, never a runtime fallback
 * that shows somebody a blank explanation. The blocked-name sentence deliberately does
 * NOT repeat the name it found - the whole point of the check is that the name stops
 * travelling, and an error message is travel.
 */
const refusalSentences = {
  "understood-blank": "Schreib zuerst, was du verstanden hast.",
  "understood-too-long": "Der Teil „Verstanden“ ist zu lang - höchstens 400 Zeichen.",
  "understood-too-many-sentences": "Höchstens zwei Sätze im Teil „Verstanden“.",
  "question-blank": "Es fehlt die Frage.",
  "question-too-long": "Die Frage ist zu lang - höchstens 200 Zeichen.",
  "question-not-single":
    "Genau eine Frage, und das Fragezeichen steht am Ende. Momentan sind es mehrere oder keine.",
  "unsafe-vocabulary": "Da steht ein Wort drin, das auf der Kinderseite nichts zu suchen hat.",
  "blocked-name": "Da steht ein Name drin, der nicht auf die Kinderseite darf.",
} as const satisfies Record<ComposeReplyRefusal, string>;

export function replyRefusalSentence(reason: ComposeReplyRefusal): string {
  return refusalSentences[reason];
}

/** What an adult is told when the reply could not be sent at all. */
export function replySendFailedSentence(): string {
  return "Die Antwort konnte nicht gespeichert werden. Bitte noch einmal versuchen.";
}

/** What an adult is told when the submission is gone. */
export function replyMissingSubmissionSentence(): string {
  return "Zu diesem Beitrag gibt es nichts mehr - er wurde gelöscht.";
}

/**
 * What "Meine Ideen" calls an answer a child wrote to a reply question (MCL-75).
 *
 * Without it, such an answer falls through to the "belongs to an earlier question"
 * sentence, because no entry in the question dataset has a `reply:` id - and a child
 * would be told their answer belongs to a question that no longer exists, minutes after
 * answering the one thing that was addressed to them personally.
 */
export function answerToReplyMessage(): string {
  return `Deine Antwort auf ${FAMILY_REPLIER_LABEL}s Frage`;
}

/** The button that opens the way back on a reply card (MCL-75). */
export function replyAnswerToggleLabel(): string {
  return "Antworten";
}

/** The label above the text field on a reply card. */
export function replyAnswerFieldLabel(): string {
  return "Deine Antwort";
}

/** The submit button on a reply card's answer form. */
export function replyAnswerSubmitLabel(): string {
  return "Antwort speichern";
}

/**
 * The submit button while the answer is on its way.
 *
 * In the table rather than inline in the component, and not for tidiness: a string a
 * child reads that is authored inside JSX is a string no test iterates, so it is checked
 * by nobody for jargon, for a timescale promise, or for claiming the project adopted
 * their idea. This one was exactly that until an adversarial review found it.
 */
export function replyAnswerSendingLabel(): string {
  return "Wird gesendet …";
}
