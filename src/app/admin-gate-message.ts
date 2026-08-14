import type { FamilySessionAttempt } from "@/application/access/family-session-client";

/**
 * What an adult reads after one admin sign-in attempt.
 *
 * A total table, so a new outcome is a compile error here rather than a silent fall
 * through to a vague sentence. Plainer than the child copy - an adult can act on
 * "try again later" - but still free of codes, variable names and status numbers: a
 * refusal that names the missing secret tells a stranger exactly what to look for.
 */
const attemptMessages = {
  // Never shown: on success the page swaps to the inbox. Present so the table stays
  // total and the success case cannot quietly acquire a wrong sentence.
  granted: "Angemeldet.",
  denied: "Dieser Zugangscode passt nicht.",
  "rate-limited": "Zu viele Versuche. Bitte einen Moment warten.",
  unavailable: "Der Zugang ist gerade nicht eingerichtet. Bitte die Konfiguration prüfen.",
  transport: "Das konnte gerade nicht geprüft werden. Bitte noch einmal versuchen.",
} as const satisfies Record<FamilySessionAttempt, string>;

export function adminGateMessage(attempt: FamilySessionAttempt): string {
  return attemptMessages[attempt];
}
