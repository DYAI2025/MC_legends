import type { FamilySessionAttempt } from "@/application/access/family-session-client";

/**
 * What a child reads after one sign-in attempt.
 *
 * Same rule as the submission messages: no codes, no status numbers, no engineering
 * vocabulary, and never a claim that something worked. Written as a total table so a
 * new outcome is a compile error here rather than silently falling through to a vague
 * sentence.
 *
 * The four failures read differently on purpose. "The code does not fit" invites
 * another try with a different code; "too many tries" asks for a pause; "not possible
 * right now" is the only one that sends a child to an adult, because it is the only
 * one nobody at the keyboard can fix.
 */
const attemptMessages = {
  // Never shown: on success the page swaps to the question. Present so the table
  // stays total and the success case cannot quietly acquire a wrong sentence.
  granted: "Das hat geklappt.",
  denied: "Dieser Familien-Code passt nicht. Versuch es bitte noch einmal.",
  "rate-limited": "Das waren zu viele Versuche. Warte bitte einen Moment.",
  unavailable: "Antworten geht gerade nicht. Sag bitte einer erwachsenen Person Bescheid.",
  transport: "Wir konnten das gerade nicht prüfen. Versuch es bitte noch einmal.",
} as const satisfies Record<FamilySessionAttempt, string>;

export function familyGateMessage(attempt: FamilySessionAttempt): string {
  return attemptMessages[attempt];
}
